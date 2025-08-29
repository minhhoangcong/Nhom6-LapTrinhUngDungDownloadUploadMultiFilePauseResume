import asyncio
import base64
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Optional
from urllib.parse import urlparse
import aiohttp
import aiofiles

import websockets
from websockets.server import WebSocketServerProtocol
from logger import setup_logger
from database import db

# Thiết lập logger cho server
logger = setup_logger("server")

# Cấu hình remote server
REMOTE_UPLOAD_URL = os.environ.get("REMOTE_UPLOAD_URL", "http://localhost:5000/api/upload")
REMOTE_SERVER_TOKEN = os.environ.get("REMOTE_SERVER_TOKEN", "your-secret-token")

# Thư mục tạm để lưu file trước khi gửi đi
TEMP_DIR = Path(__file__).parent / "temp_uploads"
TEMP_DIR.mkdir(parents=True, exist_ok=True)

# Thư mục lưu files đã download
DOWNLOADS_DIR = Path(__file__).parent / "remote_uploads"
DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)

@dataclass
class UploadSession:
    file_id: str
    file_name: str
    file_size: int
    status: str = "active"  # active | paused | completed | stopped | error | uploading
    bytes_received: int = 0
    temp_file_path: Path = field(default_factory=Path)
    remote_file_id: Optional[str] = None
    file_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    db_id: Optional[int] = None  # ID từ SQLite database

    def temp_path(self) -> Path:
    # session.temp_file_path: .../temp_uploads/<file-id>_<name>
        return self.temp_file_path.with_name(self.temp_file_path.name + ".part")

@dataclass
class DownloadSession:
    session_id: str
    url: str
    filename: str
    total_size: int = 0
    downloaded_bytes: int = 0
    status: str = "pending"  # pending | active | paused | completed | error | stopped
    temp_file_path: Optional[str] = None
    last_update: float = field(default_factory=time.time)
    
    def temp_path(self) -> str:
        if not self.temp_file_path:
            safe_filename = "".join(c for c in self.filename if c.isalnum() or c in "._- ")
            self.temp_file_path = str(TEMP_DIR / f"{self.session_id}_{safe_filename}.download")
        return self.temp_file_path


class DownloadManager:
    def __init__(self):
        self.downloads: Dict[str, DownloadSession] = {}
        self.active_downloads: Dict[str, dict] = {}
        logger.info("DownloadManager initialized")
        
    def generate_session_id(self) -> str:
        import uuid
        return str(uuid.uuid4())[:12]
        
    def create_session(self, url: str, filename: Optional[str] = None) -> DownloadSession:
        session_id = self.generate_session_id()
        if not filename:
            parsed_url = urlparse(url)
            filename = os.path.basename(parsed_url.path) or "download"
        
        session = DownloadSession(session_id, url, filename)
        self.downloads[session_id] = session
        logger.info(f"Created download session: {session_id} for {url}")
        return session
    
    def get_session(self, session_id: str) -> Optional[DownloadSession]:
        return self.downloads.get(session_id)
    
    async def start_download(self, session_id: str, websocket: WebSocketServerProtocol) -> bool:
        session = self.get_session(session_id)
        if not session:
            return False
            
        if session_id in self.active_downloads:
            return False
            
        self.active_downloads[session_id] = {
            'session': session,
            'websocket': websocket,
            'task': None
        }
        
        # Start download task
        task = asyncio.create_task(self._download_file(session, websocket))
        self.active_downloads[session_id]['task'] = task
        
        return True
    
    async def pause_download(self, session_id: str):
        if session_id in self.active_downloads:
            download_info = self.active_downloads[session_id]
            if download_info['task']:
                download_info['task'].cancel()
            download_info['session'].status = "paused"
    
    async def resume_download(self, session_id: str, websocket: WebSocketServerProtocol) -> bool:
        session = self.get_session(session_id)
        if session and session.status == "paused":
            return await self.start_download(session_id, websocket)
        return False
    
    async def stop_download(self, session_id: str):
        if session_id in self.active_downloads:
            download_info = self.active_downloads[session_id]
            if download_info['task']:
                download_info['task'].cancel()
            
            # Clean up temp file
            session = download_info['session']
            if session.temp_file_path and os.path.exists(session.temp_file_path):
                try:
                    os.remove(session.temp_file_path)
                except:
                    pass
            
            del self.active_downloads[session_id]
            if session_id in self.downloads:
                del self.downloads[session_id]
    
    async def _download_file(self, session: DownloadSession, websocket: WebSocketServerProtocol):
        try:
            session.status = "active"
            logger.info(f"Starting download: {session.session_id}")
            
            # Send start acknowledgment
            await self.send(websocket, {
                'event': 'download-start-ack',
                'fileId': session.session_id,
                'filename': session.filename,
                'offset': session.downloaded_bytes
            })
            
            timeout = aiohttp.ClientTimeout(total=300, connect=30)
            headers = {}
            
            # Resume support
            if session.downloaded_bytes > 0:
                headers['Range'] = f'bytes={session.downloaded_bytes}-'
            
            async with aiohttp.ClientSession(timeout=timeout) as client_session:
                async with client_session.get(session.url, headers=headers) as response:
                    
                    # Get total size
                    if session.total_size == 0:
                        content_length = response.headers.get('Content-Length')
                        if content_length:
                            if 'Range' in headers:
                                session.total_size = session.downloaded_bytes + int(content_length)
                            else:
                                session.total_size = int(content_length)
                    
                    # Send size info
                    await self.send(websocket, {
                        'event': 'download-info',
                        'fileId': session.session_id,
                        'totalSize': session.total_size,
                        'supportsResume': response.status == 206
                    })
                    
                    # Open file for writing
                    mode = 'ab' if session.downloaded_bytes > 0 else 'wb'
                    async with aiofiles.open(session.temp_path(), mode) as f:
                        
                        chunk_size = 64 * 1024  # 64KB chunks
                        last_progress_time = time.time()
                        
                        async for chunk in response.content.iter_chunked(chunk_size):
                            if session.status != "active":
                                break
                                
                            await f.write(chunk)
                            session.downloaded_bytes += len(chunk)
                            
                            # Send progress every 250ms
                            now = time.time()
                            if now - last_progress_time > 0.25:
                                progress = 0
                                if session.total_size > 0:
                                    progress = (session.downloaded_bytes / session.total_size) * 100
                                
                                await self.send(websocket, {
                                    'event': 'download-progress',
                                    'fileId': session.session_id,
                                    'downloadedBytes': session.downloaded_bytes,
                                    'totalSize': session.total_size,
                                    'progress': progress
                                })
                                
                                last_progress_time = now
                    
                    # Download completed
                    if session.downloaded_bytes >= session.total_size or session.total_size == 0:
                        session.status = "completed"
                        
                        # Move to final location (uploads directory)
                        final_path = DOWNLOADS_DIR / session.filename
                        counter = 1
                        base_name = final_path.stem
                        ext = final_path.suffix
                        
                        while final_path.exists():
                            final_path = DOWNLOADS_DIR / f"{base_name}_{counter}{ext}"
                            counter += 1
                        
                        os.rename(session.temp_path(), str(final_path))
                        
                        await self.send(websocket, {
                            'event': 'download-complete',
                            'fileId': session.session_id,
                            'filename': final_path.name,
                            'filePath': str(final_path),
                            'totalSize': session.downloaded_bytes
                        })
                        
        except asyncio.CancelledError:
            session.status = "paused"
            logger.info(f"Download paused: {session.session_id}")
            
        except Exception as e:
            session.status = "error"
            logger.error(f"Download error for {session.session_id}: {e}")
            
            await self.send(websocket, {
                'event': 'download-error',
                'fileId': session.session_id,
                'error': str(e)
            })
        
        finally:
            # Clean up
            if session.session_id in self.active_downloads:
                del self.active_downloads[session.session_id]
    
    async def send(self, websocket: WebSocketServerProtocol, message: dict):
        try:
            await websocket.send(json.dumps(message))
        except Exception as e:
            logger.error(f"Failed to send message: {e}")


class UploadManager:
    def __init__(self) -> None:
        self.file_id_to_session: Dict[str, UploadSession] = {}
        self.connection_to_sessions: Dict[WebSocketServerProtocol, Dict[str, UploadSession]] = {}
        logger.info("UploadManager initialized with remote upload capability")

    def register_connection(self, ws: WebSocketServerProtocol) -> None:
        if ws not in self.connection_to_sessions:
            self.connection_to_sessions[ws] = {}
        logger.debug("Connection registered: %s", ws.remote_address)

    def unregister_connection(self, ws: WebSocketServerProtocol) -> None:
        sessions = self.connection_to_sessions.pop(ws, {})
        for session in sessions.values():
            if session.status == "active":
                session.status = "paused"
                logger.info("Session paused due to disconnect: %s (%s)", 
                           session.file_id, session.file_name)
        logger.debug("Connection unregistered: %s", ws.remote_address)

    def get_or_create_session(self, file_id: str, file_name: str, file_size: int) -> UploadSession:
        safe_name = os.path.basename(file_name)
        temp_path = TEMP_DIR / f"{file_id}_{safe_name}"

        existing = self.file_id_to_session.get(file_id)
        if existing:
            existing.file_name = safe_name
            existing.file_size = file_size
            existing.temp_file_path = temp_path
            if existing.temp_path().exists():
                existing.bytes_received = existing.temp_path().stat().st_size
                logger.debug("Resuming existing session: %s, offset=%d", file_id, existing.bytes_received)
            return existing

        session = UploadSession(
            file_id=file_id,
            file_name=safe_name,
            file_size=file_size,
            status="active",
            bytes_received=0,
            temp_file_path=temp_path,
        )
        
        if session.temp_path().exists():
            session.bytes_received = session.temp_path().stat().st_size
            logger.info("Found existing partial file: %s, size=%d bytes", 
                       session.temp_path(), session.bytes_received)
        
        # Thêm file vào database với status "uploading"
        try:
            temp_filename = f"{file_id}_{safe_name}"
            session.db_id = db.add_file(
                filename=safe_name,
                original_filename=file_name,
                size=file_size,
                uploader="WebSocket Client",
                temp_path=temp_filename
            )
            logger.info(f"File added to database: {file_name} (DB ID: {session.db_id})")
        except Exception as e:
            logger.error(f"Failed to add file to database: {e}")
            session.db_id = None
        
        self.file_id_to_session[file_id] = session
        logger.info("Created new upload session: %s (%s), size=%d bytes", 
                   file_id, safe_name, file_size)
        return session

    def remove_session(self, file_id: str) -> None:
        if file_id in self.file_id_to_session:
            session = self.file_id_to_session[file_id]
            logger.debug("Removing session: %s (%s)", file_id, session.file_name)
            del self.file_id_to_session[file_id]

    async def broadcast_to_session(self, session: UploadSession, message: dict) -> None:
        """Gửi message đến tất cả client đang kết nối với session này"""
        for ws, sessions in self.connection_to_sessions.items():
            if session.file_id in sessions:
                try:
                    await self.send(ws, message)
                except Exception as e:
                    logger.warning("Failed to send message to client: %s", e)

    async def upload_to_remote_server(self, session: UploadSession) -> bool:
        """Upload completed file to remote server"""
        try:
            logger.info("Starting upload to remote server: %s (%s)", session.file_id, session.file_name)
            
            # Sử dụng temp_file_path (file đã rename, không có .part)
            file_path = session.temp_file_path
            if not file_path.exists():
                logger.error("Temp file not found: %s", file_path)
                session.status = "error"
                await self.broadcast_to_session(session, {
                    "event": "error",
                    "fileId": session.file_id,
                    "error": "File not found for remote upload"
                })
                return False
            
            # Kiểm tra file size
            actual_size = file_path.stat().st_size
            if actual_size != session.file_size:
                logger.error("File size mismatch: expected=%d, actual=%d", session.file_size, actual_size)
                session.status = "error"
                await self.broadcast_to_session(session, {
                    "event": "error",
                    "fileId": session.file_id,
                    "error": f"File size mismatch: expected {session.file_size}, got {actual_size}"
                })
                return False
            
            # Đổi status sang uploading khi bắt đầu remote upload
            session.status = "uploading"
            
            # Cập nhật database status
            if session.db_id:
                db.update_file_status(session.db_id, "uploading")
            
            await self.broadcast_to_session(session, {
                "event": "uploading",
                "fileId": session.file_id,
                "message": "Uploading to remote server..."
            })
            
            # Chuẩn bị headers
            headers = {
                'Authorization': f'Bearer {REMOTE_SERVER_TOKEN}',
                'Content-Type': 'application/octet-stream',
                'X-File-Name': session.file_name,
                'X-File-Size': str(session.file_size),
                'X-File-ID': session.file_id
            }
            
            # Gửi file đến remote server
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None)) as http_session:
                async with aiofiles.open(file_path, 'rb') as f:
                    async with http_session.post(
                        REMOTE_UPLOAD_URL,
                        data=f,              # <— truyền file-like object, aiohttp sẽ stream
                        headers=headers
                    ) as response:
                        if response.status == 200:
                            result = await response.json()
                            session.remote_file_id = result.get('file_id')
                            session.status = "completed"
                            
                            # Cập nhật database status thành completed
                            if session.db_id:
                                # Lưu thông tin file path trong remote_uploads
                                remote_file_path = f"{session.file_name}"  # Hoặc path từ result nếu có
                                db.update_file_status(session.db_id, "completed", remote_file_path)
                            
                            logger.info("File uploaded to remote server successfully: %s, remote_id=%s", 
                                    session.file_id, session.remote_file_id)
                            
                            # Thông báo cho client rằng file đã hoàn thành
                            await self.broadcast_to_session(session, {
                                "event": "completed",
                                "fileId": session.file_id,
                                "remoteFileId": session.remote_file_id,
                                "status": "completed"
                            })
                            
                            return True
                        else:
                            error_text = await response.text()
                            logger.error("Failed to upload to remote server: %s, status=%d, error=%s", 
                                    session.file_id, response.status, error_text)
                            session.status = "error"
                            await self.broadcast_to_session(session, {
                                "event": "error",
                                "fileId": session.file_id,
                                "error": f"Remote upload failed: HTTP {response.status}"
                            })
                            return False
                
                # Xóa file tạm sau khi đã đóng file handle
                if session.status == "completed":
                    try:
                        # Thêm delay nhỏ để đảm bảo file handle đã được giải phóng
                        await asyncio.sleep(0.1)
                        file_path.unlink(missing_ok=True)  # Xóa file .part
                        logger.debug("Temporary file deleted: %s", file_path)
                    except Exception as e:
                        logger.warning("Failed to delete temp file %s: %s", file_path, e)
                        
        except Exception as e:
            logger.exception("Error uploading to remote server: %s", e)
            session.status = "error"
            await self.broadcast_to_session(session, {
                "event": "error",
                "fileId": session.file_id,
                "error": f"Upload error: {str(e)}"
            })
            return False

    async def handle_start(self, ws: WebSocketServerProtocol, payload: dict) -> None:
        file_id = payload.get("fileId")
        file_name = payload.get("fileName")
        file_size = int(payload.get("fileSize", 0))
        if not file_id or not file_name or file_size <= 0:
            logger.warning("Invalid start payload: fileId=%s, fileName=%s, fileSize=%s", 
                          file_id, file_name, file_size)
            await self.send_error(ws, file_id, "Invalid start payload")
            return

        session = self.get_or_create_session(file_id, file_name, file_size)
        session.status = "active"

        self.register_connection(ws)
        self.connection_to_sessions[ws][file_id] = session

        logger.info("Upload started: %s (%s), size=%d bytes, offset=%d", 
                   file_id, file_name, file_size, session.bytes_received)

        await self.send(ws, {
            "event": "start-ack",
            "fileId": session.file_id,
            "offset": session.bytes_received,
            "status": session.status,
        })

    async def handle_chunk(self, ws: WebSocketServerProtocol, payload: dict) -> None:
        file_id = payload.get("fileId")
        data_b64 = payload.get("data")
        offset = int(payload.get("offset", -1))
        if not file_id or data_b64 is None or offset < 0:
            logger.warning("Invalid chunk payload: fileId=%s, offset=%s, data_length=%d", 
                          file_id, offset, len(data_b64) if data_b64 else 0)
            await self.send_error(ws, file_id, "Invalid chunk payload")
            return

        session = self.file_id_to_session.get(file_id)
        if not session:
            logger.warning("Chunk received for unknown session: %s", file_id)
            await self.send_error(ws, file_id, "Session not found. Send start first.")
            return

        if session.status == "paused":
            logger.debug("Chunk ignored - session paused: %s", file_id)
            await self.send(ws, {"event": "paused", "fileId": file_id, "offset": session.bytes_received})
            return
        if session.status in ("stopped", "completed", "error", "uploading"):
            logger.warning("Chunk rejected - invalid status: %s (%s)", file_id, session.status)
            await self.send_error(ws, file_id, f"Cannot accept chunk in status: {session.status}")
            return

        expected = session.bytes_received
        if offset != expected:
            logger.warning("Offset mismatch: expected=%d, received=%d for %s", 
                          expected, offset, file_id)
            await self.send(ws, {
                "event": "offset-mismatch",
                "fileId": file_id,
                "expected": expected,
                "received": offset,
            })
            return

        try:
            data = base64.b64decode(data_b64)
        except Exception as e:
            logger.error("Failed to decode base64 data for %s: %s", file_id, e)
            await self.send_error(ws, file_id, "Invalid base64 data")
            return

        # Write chunk to temp .part file
        async with session.file_lock:
            temp_path = session.temp_path()
            temp_path.parent.mkdir(parents=True, exist_ok=True)
            
            async with aiofiles.open(temp_path, 'ab') as f:
                await f.write(data)
                await f.flush()
            
            session.bytes_received += len(data)

        percent = min(100.0 * session.bytes_received / max(session.file_size, 1), 100.0)
        logger.debug("Chunk processed: %s, offset=%d, chunk_size=%d, progress=%.1f%%", 
                    file_id, session.bytes_received, len(data), percent)
        
        # Gửi phản hồi xác nhận chunk đã được xử lý
        await self.send(ws, {
            "event": "chunk-ack",
            "fileId": file_id,
            "offset": session.bytes_received,
            "receivedBytes": len(data),
            "percent": round(percent, 2),
        })
        
        # Kiểm tra nếu upload hoàn tất
        if session.bytes_received >= session.file_size:
            logger.info("Local upload completed: %s, finalizing file", file_id)
            
            # Đợi một chút để đảm bảo file được flush hoàn toàn
            await asyncio.sleep(0.1)
            
            # Đổi status nhưng KHÔNG upload to remote ở đây
            # Để handle_complete xử lý việc rename và upload
            session.status = "completing"
            await self.send(ws, {
                "event": "local-complete", 
                "fileId": file_id,
                "message": "Local upload completed, finalizing..."
            })

    async def handle_pause(self, ws: WebSocketServerProtocol, payload: dict) -> None:
        file_id = payload.get("fileId")
        session = self.file_id_to_session.get(file_id)
        if not session:
            logger.warning("Pause requested for unknown session: %s", file_id)
            await self.send_error(ws, file_id, "Session not found")
            return
        session.status = "paused"
        
        # Cập nhật database status
        if session.db_id:
            db.update_file_status(session.db_id, "paused")
        
        logger.info("Upload paused: %s (%s)", file_id, session.file_name)
        await self.send(ws, {"event": "paused", "fileId": file_id, "offset": session.bytes_received})

    async def handle_resume(self, ws: WebSocketServerProtocol, payload: dict) -> None:
        file_id = payload.get("fileId")
        session = self.file_id_to_session.get(file_id)
        if not session:
            logger.warning("Resume requested for unknown session: %s", file_id)
            await self.send_error(ws, file_id, "Session not found")
            return
        session.status = "active"
        
        # Cập nhật database status
        if session.db_id:
            db.update_file_status(session.db_id, "uploading")
        
        logger.info("Upload resumed: %s (%s)", file_id, session.file_name)
        await self.send(ws, {"event": "resume-ack", "fileId": file_id, "offset": session.bytes_received})

    async def handle_stop(self, ws: WebSocketServerProtocol, payload: dict) -> None:
        file_id = payload.get("fileId")
        delete = bool(payload.get("delete", True))
        session = self.file_id_to_session.get(file_id)
        if not session:
            logger.warning("Stop requested for unknown session: %s", file_id)
            await self.send_error(ws, file_id, "Session not found")
            return
        session.status = "stopped"
        logger.info("Upload stopped: %s (%s), delete=%s", file_id, session.file_name, delete)
        
        # Xóa file khỏi database nếu yêu cầu
        if delete and session.db_id:
            db.delete_file(session.db_id)
            logger.info(f"File deleted from database: {file_id}")
        
        # Remove temp file if requested
        temp_path = session.temp_path()
        if delete and temp_path.exists():
            try:
                temp_path.unlink()
                logger.debug("Temporary file deleted: %s", temp_path)
            except Exception as exc:
                logger.warning("Failed to delete temp file %s: %s", temp_path, exc)
        
        self.remove_session(file_id)
        if ws in self.connection_to_sessions:
            self.connection_to_sessions[ws].pop(file_id, None)
        await self.send(ws, {"event": "stop-ack", "fileId": file_id})

    async def handle_complete(self, ws: WebSocketServerProtocol, payload: dict) -> None:
        file_id = payload.get("fileId")
        session = self.file_id_to_session.get(file_id)
        if not session:
            logger.warning("Complete requested for unknown session: %s", file_id)
            await self.send_error(ws, file_id, "Session not found")
            return

        # Validate size
        if session.bytes_received != session.file_size:
            logger.warning("Size mismatch for %s: expected=%d, actual=%d", 
                          file_id, session.file_size, session.bytes_received)
            await self.send_error(ws, file_id, "Size mismatch. Not completed.")
            return

        # Rename .part to final temp file
        async with session.file_lock:
            temp_path = session.temp_path()
            if not temp_path.exists():
                logger.error("Temporary file missing for %s: %s", file_id, temp_path)
                await self.send_error(ws, file_id, "Temporary file missing")
                return
            
            try:
                final_temp_path = session.temp_file_path
                temp_path.rename(final_temp_path)
                logger.info("File completed locally: %s (%s) -> %s", 
                           file_id, session.file_name, final_temp_path.name)
                
                # Bắt đầu upload lên remote server
                success = await self.upload_to_remote_server(session)
                
                if success:
                    await self.send(ws, {
                        "event": "complete-ack",
                        "fileId": file_id,
                        "remoteFileId": session.remote_file_id,
                        "status": "uploaded_to_remote"
                    })
                else:
                    await self.send_error(ws, file_id, "Failed to upload to remote server")
                    return
                    
            except Exception as exc:
                session.status = "error"
                logger.error("Failed to finalize upload %s: %s", file_id, exc)
                await self.send_error(ws, file_id, f"Finalize failed: {exc}")
                return
        
        # Cleanup session
        self.remove_session(file_id)

    async def send(self, ws: WebSocketServerProtocol, message: dict) -> None:
        await ws.send(json.dumps(message))

    async def send_error(self, ws: WebSocketServerProtocol, file_id: Optional[str], error: str) -> None:
        payload = {"event": "error", "error": error}
        if file_id:
            payload["fileId"] = file_id
        logger.error("Sending error to client: %s", error)
        await ws.send(json.dumps(payload))


manager = UploadManager()
download_manager = DownloadManager()


async def handler(ws: WebSocketServerProtocol, path: str) -> None:
    # Accept any path but recommend "/ws"
    logger.info("Client connected from %s path=%s", ws.remote_address, path)
    # Register connection for per-connection session tracking
    manager.register_connection(ws)
    try:
        async for message in ws:
            try:
                data = json.loads(message)
            except json.JSONDecodeError:
                logger.warning("Invalid JSON received from %s: %s", ws.remote_address, message[:100])
                await manager.send_error(ws, None, "Invalid JSON")
                continue

            action = data.get("action")
            logger.debug("Received action '%s' from %s", action, ws.remote_address)
            
            # Upload actions
            if action == "start":
                await manager.handle_start(ws, data)
            elif action == "chunk":
                await manager.handle_chunk(ws, data)
            elif action == "pause":
                await manager.handle_pause(ws, data)
            elif action == "resume":
                await manager.handle_resume(ws, data)
            elif action == "stop":
                await manager.handle_stop(ws, data)
            elif action == "complete":
                await manager.handle_complete(ws, data)
            
            # Download actions
            elif action == "download-start":
                url = data.get("url")
                filename = data.get("filename")
                file_id = data.get("fileId")
                
                if not url:
                    await download_manager.send(ws, {
                        'event': 'download-error',
                        'fileId': file_id,
                        'error': 'URL is required'
                    })
                    continue
                
                # Create download session
                session = download_manager.create_session(url, filename)
                # Use client's fileId for consistency
                if file_id:
                    old_id = session.session_id
                    session.session_id = file_id
                    download_manager.downloads[file_id] = session
                    del download_manager.downloads[old_id]
                
                # Start download
                success = await download_manager.start_download(session.session_id, ws)
                if not success:
                    await download_manager.send(ws, {
                        'event': 'download-error',
                        'fileId': session.session_id,
                        'error': 'Failed to start download'
                    })
            
            elif action == "download-pause":
                file_id = data.get("fileId")
                await download_manager.pause_download(file_id)
                await download_manager.send(ws, {
                    'event': 'download-pause-ack',
                    'fileId': file_id
                })
            
            elif action == "download-resume":
                file_id = data.get("fileId")
                success = await download_manager.resume_download(file_id, ws)
                if success:
                    await download_manager.send(ws, {
                        'event': 'download-resume-ack',
                        'fileId': file_id
                    })
                else:
                    await download_manager.send(ws, {
                        'event': 'download-error',
                        'fileId': file_id,
                        'error': 'Failed to resume download'
                    })
            
            elif action == "download-stop":
                file_id = data.get("fileId")
                await download_manager.stop_download(file_id)
                await download_manager.send(ws, {
                    'event': 'download-stop-ack',
                    'fileId': file_id
                })
            
            else:
                logger.warning("Unknown action '%s' from %s", action, ws.remote_address)
                await manager.send_error(ws, data.get("fileId"), f"Unknown action: {action}")
    except websockets.exceptions.ConnectionClosedError:
        logger.info("Client disconnected abruptly: %s", ws.remote_address)
    except Exception as exc:
        logger.exception("Unhandled error from %s: %s", ws.remote_address, exc)
    finally:
        # Pause all active sessions tied to this connection to enable resume later
        manager.unregister_connection(ws)
        logger.info("Connection closed: %s", ws.remote_address)


async def main() -> None:
    host = os.environ.get("WS_HOST", "localhost")
    port = int(os.environ.get("WS_PORT", "8765"))
    async with websockets.serve(handler, host, port, origins=None, max_size=8 * 1024 * 1024):  # 8 MB frame
        logger.info("WebSocket server listening on ws://%s:%d", host, port)
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Server stopped by user")