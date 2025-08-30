from flask import Flask, render_template, request, jsonify, send_file, abort, session, redirect, url_for
from flask_cors import CORS
import os
import json
import uuid
import sqlite3
import re
from datetime import datetime, timedelta
from pathlib import Path
import shutil
from werkzeug.utils import secure_filename
import logging
from database import db
from auth_database import AuthDatabase
from functools import wraps

# Thiết lập logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
# SECURITY FIX: Restrict CORS to specific origins in production
allowed_origins = os.environ.get('ALLOWED_ORIGINS', 'http://localhost:8000,http://localhost:3000').split(',')
CORS(app, supports_credentials=True, origins=allowed_origins)
# SECURITY FIX: Use environment variable for secret key
app.secret_key = os.environ.get('SECRET_KEY', os.urandom(32).hex())

# Khởi tạo auth database
auth_db = AuthDatabase()

# Cấu hình
UPLOAD_FOLDER = Path(__file__).parent / "remote_uploads"
TEMP_FOLDER = Path(__file__).parent / "temp_uploads"
UPLOAD_FOLDER.mkdir(parents=True, exist_ok=True)
TEMP_FOLDER.mkdir(parents=True, exist_ok=True)

# Authentication decorators
def login_required(f):
    """Decorator yêu cầu đăng nhập"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # Kiểm tra session token
        token = request.headers.get('Authorization')
        logger.info(f"🔐 Login check - Authorization header: {token}")
        if token and token.startswith('Bearer '):
            token = token[7:]  # Remove 'Bearer ' prefix
            user = auth_db.get_user_by_token(token)
            if user:
                logger.info(f"✅ User found by token: {user}")
                request.current_user = user
                return f(*args, **kwargs)
        
        # Kiểm tra session cookie
        logger.info(f"🍪 Session data: {dict(session)}")
        if 'user_token' in session:
            user = auth_db.get_user_by_token(session['user_token'])
            if user:
                logger.info(f"✅ User found by session: {user['username']} (ID: {user['id']})")
                request.current_user = user
                return f(*args, **kwargs)
        
        logger.warning("❌ No valid authentication found")
        return jsonify({'error': 'Authentication required'}), 401
    return decorated_function

def get_current_user():
    """Lấy thông tin user hiện tại"""
    if hasattr(request, 'current_user'):
        logger.info(f"🔐 Found current_user: {request.current_user['username']} (ID: {request.current_user['id']})")
        return request.current_user
    logger.warning("⚠️ No current_user found in request")
    return None

def admin_required(f):
    """Decorator yêu cầu quyền admin"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        user = get_current_user()
        if not user or user.get('role') != 'admin':
            return jsonify({'error': 'Admin access required'}), 403
        return f(*args, **kwargs)
    return decorated_function

# Cấu hình
UPLOAD_FOLDER = Path(__file__).parent / "remote_uploads"
TEMP_FOLDER = Path(__file__).parent / "temp_uploads"
UPLOAD_FOLDER.mkdir(parents=True, exist_ok=True)
TEMP_FOLDER.mkdir(parents=True, exist_ok=True)

# Legacy JSON database cho folders (giữ lại tạm thời)
DB_FILE = UPLOAD_FOLDER / "files_db.json"

def load_legacy_db():
    """Load legacy database từ file JSON (chỉ cho folders)"""
    if DB_FILE.exists():
        try:
            with open(DB_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                # Chỉ trả về folders, files sẽ lấy từ SQLite
                return {"folders": data.get("folders", [])}
        except Exception as e:
            logger.error(f"Error loading legacy database: {e}")
    return {"folders": []}

def save_legacy_db(data):
    """Lưu legacy database vào file JSON (chỉ cho folders)"""
    try:
        with open(DB_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.error(f"Error saving database: {e}")

def create_folder_structure(file_path):
    """Tạo cấu trúc folder cho file"""
    folder_path = file_path.parent
    folder_path.mkdir(parents=True, exist_ok=True)
    return folder_path

@app.route('/')
def index():
    """Trang chính quản lý files - yêu cầu đăng nhập"""
    # Kiểm tra authentication
    token = session.get('user_token')
    if token:
        user = auth_db.get_user_by_token(token)
        if user:
            return render_template('index.html', user=user)
    
    # Chưa đăng nhập -> redirect to login
    return redirect(url_for('login_page'))

@app.route('/login')
def login_page():
    """Trang đăng nhập"""
    return render_template('login.html')

@app.route('/register')
def register_page():
    """Trang đăng ký"""
    return render_template('register.html')

@app.route('/admin')
@login_required
@admin_required
def admin_page():
    """Trang admin - chỉ cho admin"""
    return render_template('admin.html')

# Authentication API Routes
@app.route('/api/login', methods=['POST'])
def login():
    """API đăng nhập"""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'Invalid JSON data'}), 400
            
        username = data.get('username', '').strip()
        password = data.get('password', '')
        
        # SECURITY FIX: Input validation
        if not username or not password:
            logger.warning(f"🔑 Missing credentials")
            return jsonify({'error': 'Username and password required'}), 400
            
        if len(username) > 50 or len(password) > 100:
            logger.warning(f"🔑 Input too long")
            return jsonify({'error': 'Input too long'}), 400
            
        # Basic sanitization
        if not username.replace('_', '').replace('-', '').isalnum():
            logger.warning(f"🔑 Invalid username format")
            return jsonify({'error': 'Invalid username format'}), 400
        
        logger.info(f"🔑 Login attempt for username: {username}")
        
        # Xác thực user
        logger.info(f"🔑 Authenticating user: {username}")
        user = auth_db.authenticate_user(username, password)
        logger.info(f"🔑 Authentication result: {user is not None}")
        
        if user:
            logger.info(f"🔑 Login successful for user: {user['username']} (ID: {user['id']}, Role: {user['role']})")
            # Tạo session token
            token = auth_db.create_session(user['id'])
            session['user_token'] = token
            
            return jsonify({
                'success': True,
                'user': user,
                'token': token
            })
        else:
            logger.warning(f"🔑 Login failed for username: {username}")
            return jsonify({'error': 'Invalid username or password'}), 401
            
    except Exception as e:
        logger.error(f"Login error: {e}")
        return jsonify({'error': 'Internal server error'}), 500

@app.route('/api/register', methods=['POST'])
def register():
    """API đăng ký user mới"""
    try:
        data = request.get_json()
        username = data.get('username')
        password = data.get('password')
        
        if not username or not password:
            return jsonify({'error': 'Username and password required'}), 400
        
        if len(password) < 6:
            return jsonify({'error': 'Password must be at least 6 characters'}), 400
        
        # Tạo user mới
        user_id = auth_db.create_user(username, password)
        if user_id:
            return jsonify({
                'success': True,
                'message': 'User registered successfully',
                'user_id': user_id
            })
        else:
            return jsonify({'error': 'Username already exists'}), 409
            
    except Exception as e:
        logger.error(f"Register error: {e}")
        return jsonify({'error': 'Internal server error'}), 500

@app.route('/api/logout', methods=['POST'])
def logout():
    """API đăng xuất"""
    try:
        token = session.get('user_token')
        if token:
            auth_db.invalidate_session(token)
            session.pop('user_token', None)
        
        return jsonify({'success': True, 'message': 'Logged out successfully'})
    except Exception as e:
        logger.error(f"Logout error: {e}")
        return jsonify({'error': 'Internal server error'}), 500

@app.route('/api/auth/check', methods=['GET'])
def check_auth():
    """Kiểm tra authentication status và trả về token"""
    try:
        token = session.get('user_token')
        if token:
            user = auth_db.get_user_by_token(token)  # Sử dụng get_user_by_token thay vì verify_session_token
            if user:
                return jsonify({
                    'authenticated': True,
                    'user': user,
                    'token': token
                })
        
        return jsonify({'authenticated': False, 'error': 'Not authenticated'}), 401
    except Exception as e:
        logger.error(f"Auth check error: {e}")
        return jsonify({'authenticated': False, 'error': 'Internal server error'}), 500

@app.route('/api/user')
@login_required
def get_user_info():
    """Lấy thông tin user hiện tại"""
    user = get_current_user()
    return jsonify({'user': user})

@app.route('/api/upload', methods=['POST'])
@login_required
def upload_file():
    """API endpoint để nhận file từ WebSocket server với user context"""
    try:
        user = get_current_user()
        logger.info(f"Upload request from user: {user['id']} ({user['username']})")
        
        # Lấy thông tin từ headers
        file_name = request.headers.get('X-File-Name')
        file_size = int(request.headers.get('X-File-Size', 0))
        file_id = request.headers.get('X-File-ID')
        folder_id = request.headers.get('X-Folder-ID')  # Optional folder
        
        logger.info(f"Upload file: {file_name}, size: {file_size}, id: {file_id}")
        
        if not file_name or not file_size or not file_id:
            return jsonify({"error": "Missing required headers"}), 400
        
        # Tạo tên file an toàn
        safe_filename = secure_filename(file_name)
        
        # Tạo đường dẫn file với user folder (sử dụng username thay vì user_id)
        user_folder = UPLOAD_FOLDER / user['username']
        user_folder.mkdir(exist_ok=True)
        file_path = user_folder / safe_filename
        
        # Xử lý trùng tên file
        counter = 1
        original_name = file_path.stem
        original_ext = file_path.suffix
        while file_path.exists():
            file_path = user_folder / f"{original_name} ({counter}){original_ext}"
            counter += 1
        
        # Lưu file
        with open(file_path, 'wb') as f:
            chunk_size = 1024 * 1024  # 1MB
            while True:
                chunk = request.stream.read(chunk_size)
                if not chunk:
                    break
                f.write(chunk)

        # Lưu thông tin file vào SQLite database với user_id
        try:
            file_db_id = db.add_file(
                filename=safe_filename,
                original_filename=file_name,
                size=file_size,
                uploader=user['username'],
                user_id=user['id'],
                folder_id=folder_id,
                temp_path=None  # File đã hoàn tất, không còn ở temp
            )
            
            # Cập nhật status thành completed và lưu file_path tương đối
            # Lấy tên file cuối cùng sau khi xử lý duplicate
            final_filename = file_path.name
            relative_file_path = f"{user['username']}/{final_filename}"
            
            db.update_file_status(
                file_id=file_db_id,
                status="completed",
                file_path=relative_file_path
            )
            
            logger.info(f"File uploaded successfully: {file_name} -> {file_path} (DB ID: {file_db_id})")
            
            return jsonify({
                "success": True,
                "file_id": file_db_id,
                "message": "File uploaded successfully"
            })
            
        except Exception as db_error:
            # Nếu lỗi database, xóa file đã tạo
            if file_path.exists():
                file_path.unlink()
            logger.error(f"Database error: {db_error}")
            return jsonify({"error": "Database error"}), 500
    except Exception as e:
        logger.error(f"Error uploading file: {e}")
        return jsonify({"error": str(e)}), 500

def cleanup_stuck_uploads(user_id):
    """Clean up files stuck in uploading status for more than 30 minutes"""
    try:
        cutoff_time = datetime.now() - timedelta(minutes=30)
        
        # Get files stuck in uploading status
        with sqlite3.connect(db.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT id, filename FROM files 
                WHERE user_id = ? AND status = 'uploading' 
                AND datetime(created_at) < datetime(?)
            """, (user_id, cutoff_time.isoformat()))
            
            stuck_files = cursor.fetchall()
            
            if stuck_files:
                logger.info(f"🧹 Found {len(stuck_files)} stuck uploads for user {user_id}, cleaning up...")
                
                # Delete stuck uploads
                for file_id, filename in stuck_files:
                    cursor.execute("DELETE FROM files WHERE id = ?", (file_id,))
                    logger.info(f"  Deleted stuck upload: {filename}")
                
                conn.commit()
                logger.info(f"✅ Cleaned up {len(stuck_files)} stuck uploads")
        
    except Exception as e:
        logger.error(f"Error cleaning up stuck uploads: {e}")

@app.route('/api/files', methods=['GET'])
@login_required
def get_files():
    """Lấy danh sách files của user hiện tại từ SQLite database"""
    try:
        user = get_current_user()
        logger.info(f"🔍 API /api/files called by user: {user['id']} ({user['username']})")
        
        # FIX: Clean up stuck uploads before returning files
        cleanup_stuck_uploads(user['id'])
        
        # Lấy tham số query
        status = request.args.get('status')  # completed, uploading, paused
        limit = request.args.get('limit', type=int)
        offset = request.args.get('offset', 0, type=int)
        
        # Lấy files của user từ database
        files = db.get_user_files(user['id'], status=status)
        logger.info(f"📁 Found {len(files)} files for user {user['id']}")
        
        # Log first few files for debugging
        for i, f in enumerate(files[:3]):
            logger.info(f"  File {i+1}: {f['original_filename']} (Status: {f['status']}, Path: {f.get('file_path', 'NULL')})")
        
        # Convert format cho frontend compatibility
        formatted_files = []
        for file in files:
            # Normalize file path separators cho consistency
            normalized_path = file["file_path"].replace('\\', '/') if file["file_path"] else None
            
            formatted_files.append({
                "id": file["id"],
                "name": file["original_filename"],
                "filename": file["original_filename"],
                "file_path": normalized_path,
                "folder_id": file.get("folder_id"),
                "size": file["size"],
                "upload_time": file["created_at"],
                "status": file["status"],
                "uploader": file["uploader"],
                "user_id": file["user_id"],
                "type": "file"
            })
        
        logger.info(f"✅ Returning {len(formatted_files)} formatted files to frontend")
        return jsonify(formatted_files)
    except Exception as e:
        logger.error(f"Error getting files: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/folders', methods=['GET'])
@login_required
def get_folders():
    """Lấy danh sách folders của user hiện tại từ legacy database - USER ISOLATED"""
    try:
        user = get_current_user()
        user_id = user['id']
        parent_id = request.args.get('parent_id')  # Thêm filter by parent_id
        legacy_data = load_legacy_db()
        
        # Lọc folders của user hiện tại
        user_folders = []
        for folder in legacy_data.get("folders", []):
            # Chỉ lấy folders của user hiện tại
            if folder.get("user_id") == user_id:
                if parent_id is not None:
                    # Filter by parent_id nếu có
                    if folder.get("parent_id") == parent_id:
                        user_folders.append(folder)
                else:
                    # Lấy tất cả folders của user
                    user_folders.append(folder)
        
        logger.info(f"Found {len(user_folders)} folders for user {user['username']}")
        return jsonify(user_folders)
    except Exception as e:
        logger.error(f"Error getting folders: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/files/<int:file_id>', methods=['GET'])
def get_file_info(file_id):
    """Lấy thông tin chi tiết của file từ SQLite database"""
    try:
        file_info = db.get_file_by_id(file_id)
        if file_info:
            # Format để tương thích với frontend
            formatted_info = {
                "id": file_info["id"],
                "name": file_info["original_filename"],
                "path": file_info["file_path"] or "",
                "size": file_info["size"],
                "upload_time": file_info["created_at"],
                "status": file_info["status"],
                "type": "file"
            }
            return jsonify(formatted_info)
        return jsonify({"error": "File not found"}), 404
    except Exception as e:
        logger.error(f"Error getting file info: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/files/<int:file_id>/download', methods=['GET'])
@login_required
def download_file(file_id):
    """Download file từ SQLite database với authentication"""
    try:
        current_user = get_current_user()
        if not current_user:
            return jsonify({"error": "Authentication required"}), 401

        logger.info(f"🔽 Download request for file {file_id} by user {current_user['username']} (ID: {current_user['id']})")
        
        file_info = db.get_file_by_id(file_id)
        if not file_info:
            logger.warning(f"File {file_id} not found in database")
            return jsonify({"error": "File not found"}), 404

        logger.info(f"🔽 File info: {file_info['original_filename']}, status: {file_info['status']}, path: {file_info['file_path']}")

        # Kiểm tra quyền truy cập - user chỉ download file của mình, admin download tất cả
        if current_user['role'] != 'admin' and file_info.get('user_id') != current_user['id']:
            logger.warning(f"User {current_user['id']} attempted to download file {file_id} owned by user {file_info.get('user_id')}")
            return jsonify({"error": "Permission denied"}), 403

        # Chỉ cho phép download file đã completed
        if file_info["status"] != "completed":
            return jsonify({"error": "File not ready for download"}), 400
        
        if file_info["file_path"]:
            # SECURITY FIX: Validate and sanitize file path to prevent path traversal
            file_path = UPLOAD_FOLDER / file_info["file_path"]
            
            # CRITICAL: Ensure the resolved path is still within UPLOAD_FOLDER
            try:
                file_path = file_path.resolve()
                upload_folder_resolved = UPLOAD_FOLDER.resolve()
                
                if not str(file_path).startswith(str(upload_folder_resolved)):
                    logger.error(f"🚨 SECURITY: Path traversal attempt detected! Path: {file_path}")
                    return jsonify({"error": "Access denied"}), 403
                    
            except Exception as e:
                logger.error(f"🚨 SECURITY: Path resolution error: {e}")
                return jsonify({"error": "Invalid file path"}), 400
            
            logger.info(f"🔽 Looking for file at: {file_path}")
            
            if file_path.exists():
                logger.info(f"🔽 File found at original path, sending: {file_info['original_filename']}")
                return send_file(
                    file_path,
                    as_attachment=True,
                    download_name=file_info["original_filename"]
                )
            else:
                # If original path fails, try searching in user folders
                logger.info(f"🔽 File not found at original path, searching in user folders...")
                filename = secure_filename(file_info["original_filename"])  # SECURITY: Re-sanitize
                
                # SECURITY FIX: Only search in the current user's folder
                user_folder = UPLOAD_FOLDER / current_user['username']
                if user_folder.exists() and user_folder.is_dir():
                    potential_path = user_folder / filename
                    potential_path = potential_path.resolve()
                    
                    # CRITICAL: Ensure the resolved path is still within user's folder
                    if str(potential_path).startswith(str(user_folder.resolve())):
                        logger.info(f"🔽 Checking: {potential_path}")
                        if potential_path.exists():
                            logger.info(f"🔽 File found in user folder, sending: {filename}")
                            return send_file(
                                potential_path,
                                as_attachment=True,
                                download_name=filename
                            )
                
                logger.error(f"🔽 File not found: {filename}")
                return jsonify({"error": "File not found on disk"}), 404
        else:
            logger.error(f"🔽 File path not available for file {file_id}")
            return jsonify({"error": "File path not available"}), 404
            
    except Exception as e:
        logger.error(f"Error downloading file {file_id}: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/files/<int:file_id>/preview', methods=['GET'])
@login_required
def preview_file(file_id):
    """Preview file - serve file for preview purposes"""
    try:
        user = get_current_user()
        file_info = db.get_file_by_id(file_id)
        
        if not file_info:
            return jsonify({"error": "File not found"}), 404
            
        # Check if user has permission to view this file
        if file_info["user_id"] != user['id'] and user.get('role') != 'admin':
            return jsonify({"error": "Permission denied"}), 403
            
        # Chỉ cho phép preview file đã completed
        if file_info["status"] != "completed":
            return jsonify({"error": "File not ready for preview"}), 400
        
        if file_info["file_path"]:
            file_path = UPLOAD_FOLDER / file_info["file_path"]
            if file_path.exists():
                # Determine file type for appropriate headers
                file_ext = file_path.suffix.lower()
                
                # Set appropriate MIME type
                mime_types = {
                    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                    '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
                    '.pdf': 'application/pdf', '.txt': 'text/plain',
                    '.mp4': 'video/mp4', '.avi': 'video/avi', '.mov': 'video/quicktime',
                    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg'
                }
                
                mimetype = mime_types.get(file_ext, 'application/octet-stream')
                
                return send_file(
                    file_path,
                    mimetype=mimetype,
                    as_attachment=False,  # Display inline for preview
                    download_name=file_info["original_filename"]
                )
            else:
                return jsonify({"error": "File not found on disk"}), 404
        else:
            return jsonify({"error": "File path not available"}), 404
            
    except Exception as e:
        logger.error(f"Error previewing file: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/files/<int:file_id>/info', methods=['GET'])
@login_required
def get_file_preview_info(file_id):
    """Get file information for preview purposes"""
    try:
        user = get_current_user()
        file_info = db.get_file_by_id(file_id)
        
        if not file_info:
            return jsonify({"error": "File not found"}), 404
            
        # Check permissions
        if file_info["user_id"] != user['id'] and user.get('role') != 'admin':
            return jsonify({"error": "Permission denied"}), 403
        
        # Determine preview type based on file extension
        file_ext = Path(file_info["original_filename"]).suffix.lower()
        
        preview_type = "download"  # default
        if file_ext in ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']:
            preview_type = "image"
        elif file_ext == '.pdf':
            preview_type = "pdf"
        elif file_ext in ['.mp4', '.avi', '.mov', '.webm']:
            preview_type = "video"
        elif file_ext in ['.mp3', '.wav', '.ogg']:
            preview_type = "audio"
        elif file_ext in ['.txt', '.md', '.csv']:
            preview_type = "text"
        
        return jsonify({
            "id": file_info["id"],
            "name": file_info["original_filename"],
            "size": file_info["size"],
            "upload_time": file_info["created_at"],
            "preview_type": preview_type,
            "extension": file_ext,
            "preview_url": f"/api/files/{file_id}/preview" if preview_type != "download" else None
        })
        
    except Exception as e:
        logger.error(f"Error getting file preview info: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/folders', methods=['POST'])
@login_required
def create_folder():
    """Tạo folder mới (có thể nested) - USER ISOLATED"""
    try:
        # Lấy user hiện tại từ request.current_user
        user = get_current_user()
        if not user:
            return jsonify({"error": "User not found"}), 401
            
        user_id = user['id']
        username = user['username']
        
        data = request.get_json()
        folder_name = data.get('name')
        parent_id = data.get('parent_id')  # Thêm support cho parent folder
        
        if not folder_name:
            return jsonify({"error": "Folder name is required"}), 400
        
        # Xác định path cho folder mới - THEO USER
        user_base_path = f"{username}"
        
        if parent_id:
            # Tìm parent folder - CHỈ TRONG FOLDER CỦA USER
            legacy_data = load_legacy_db()
            parent_folder = None
            for folder in legacy_data["folders"]:
                if folder["id"] == parent_id and folder.get("user_id") == user_id:
                    parent_folder = folder
                    break
            
            if not parent_folder:
                return jsonify({"error": "Parent folder not found or access denied"}), 404
            
            # Tạo nested path trong folder của user
            folder_path = UPLOAD_FOLDER / parent_folder["path"] / folder_name
            relative_path = str((Path(parent_folder["path"]) / folder_name))
        else:
            # Root level folder - TRONG FOLDER CỦA USER
            folder_path = UPLOAD_FOLDER / user_base_path / folder_name
            relative_path = f"{user_base_path}/{folder_name}"
        
        # Tạo folder trên disk
        folder_path.mkdir(parents=True, exist_ok=True)
        
        # Tạo thông tin folder - VỚI USER_ID
        folder_info = {
            "id": str(uuid.uuid4()),
            "name": folder_name,
            "path": relative_path,
            "parent_id": parent_id,
            "user_id": user_id,  # QUAN TRỌNG: Gán folder cho user
            "username": username,
            "created_time": datetime.now().isoformat(),
            "type": "folder"
        }
        
        # Lưu vào legacy database (cho folders)
        legacy_data = load_legacy_db()
        legacy_data["folders"].append(folder_info)
        save_legacy_db(legacy_data)
        
        logger.info(f"Folder created: {folder_name} by user {username} (user_id: {user_id}, parent: {parent_id})")
        return jsonify({
            "success": True,
            "folder_id": folder_info["id"],
            "message": "Folder created successfully"
        })
        
    except Exception as e:
        logger.error(f"Error creating folder: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/folders/<folder_id>', methods=['DELETE'])
@login_required
def delete_folder(folder_id):
    """Xóa folder từ legacy database - USER ISOLATED"""
    try:
        user = get_current_user()
        user_id = user['id']
        logger.info(f"Deleting folder {folder_id} for user {user['username']} (ID: {user_id})")
        
        # FIX: First, move all files in this folder to recycle bin
        files_in_folder = db.get_files_by_folder(folder_id, user_id)
        deleted_files_count = 0
        
        for file_info in files_in_folder:
            success = db.move_to_recycle_bin(file_info['id'], user_id, days_to_keep=7)
            if success:
                deleted_files_count += 1
                logger.info(f"Moved file {file_info['filename']} to recycle bin")
        
        logger.info(f"Moved {deleted_files_count} files to recycle bin before deleting folder")
        
        legacy_data = load_legacy_db()
        for i, folder_info in enumerate(legacy_data["folders"]):
            if folder_info["id"] == folder_id and folder_info.get("user_id") == user_id:
                # Xóa folder từ disk
                folder_path = UPLOAD_FOLDER / folder_info["path"]
                logger.info(f"Attempting to delete folder path: {folder_path}")
                if folder_path.exists():
                    shutil.rmtree(folder_path)
                    logger.info(f"Successfully deleted folder from disk: {folder_path}")
                
                # Xóa khỏi legacy database
                deleted_folder = legacy_data["folders"].pop(i)
                save_legacy_db(legacy_data)
                
                logger.info(f"Folder deleted: {deleted_folder['name']} by user {user['username']}")
                return jsonify({
                    "success": True, 
                    "message": f"Folder deleted successfully. {deleted_files_count} files moved to recycle bin.",
                    "deleted_files": deleted_files_count
                })
        
        logger.warning(f"Folder {folder_id} not found or access denied for user {user_id}")
        return jsonify({"error": "Folder not found or access denied"}), 404
    except Exception as e:
        logger.error(f"Error deleting folder: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/stats', methods=['GET'])
@login_required
def get_stats():
    """Lấy thống kê của user hiện tại từ SQLite database"""
    try:
        user = get_current_user()
        logger.info(f"Getting stats for user: {user['id']} ({user['username']})")
        
        # Lấy files của user hiện tại
        user_files = db.get_user_files(user['id'])
        
        # Tính toán stats cho user
        total_files = len(user_files)
        completed_files = len([f for f in user_files if f['status'] == 'completed'])
        uploading_files = len([f for f in user_files if f['status'] == 'uploading'])
        paused_files = len([f for f in user_files if f['status'] == 'paused'])
        total_size = sum(f['size'] or 0 for f in user_files if f['status'] == 'completed')
        
        # Lấy folder stats từ legacy database - FILTER THEO USER_ID (kể cả admin)
        legacy_data = load_legacy_db()
        user_folders = []
        for folder in legacy_data.get("folders", []):
            # Chỉ đếm folders thuộc về user hiện tại
            if folder.get("user_id") == user['id']:
                user_folders.append(folder)
        
        total_folders = len(user_folders)
        
        # Lấy thống kê file types từ completed files của user
        file_types = {}
        for file_info in user_files:
            if file_info['status'] == 'completed':
                ext = Path(file_info["original_filename"]).suffix.lower()
                if ext:
                    file_types[ext] = file_types.get(ext, 0) + 1
        
        logger.info(f"User {user['id']} stats: {total_files} files, {completed_files} completed")
        
        return jsonify({
            "total_files": total_files,
            "completed_files": completed_files,
            "uploading_files": uploading_files,
            "paused_files": paused_files,
            "total_folders": total_folders,
            "total_size": total_size,
            "file_types": file_types
        })
    except Exception as e:
        logger.error(f"Error getting stats: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/files/status/<status>', methods=['GET'])
def get_files_by_status(status):
    """Lấy files theo status cụ thể"""
    try:
        valid_statuses = ['uploading', 'paused', 'completed', 'error']
        if status not in valid_statuses:
            return jsonify({"error": f"Invalid status. Valid: {valid_statuses}"}), 400
        
        files = db.get_all_files(status=status)
        formatted_files = []
        for file in files:
            formatted_files.append({
                "id": file["id"],
                "name": file["original_filename"],
                "path": file["file_path"] or "",
                "size": file["size"],
                "upload_time": file["created_at"],
                "status": file["status"],
                "type": "file"
            })
        
        return jsonify(formatted_files)
    except Exception as e:
        logger.error(f"Error getting files by status: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/cleanup', methods=['POST'])
def cleanup_old_files():
    """Dọn dẹp các file tạm cũ"""
    try:
        deleted_count = db.cleanup_temp_files()
        return jsonify({
            "success": True,
            "deleted_count": deleted_count,
            "message": f"Cleaned up {deleted_count} old files"
        })
    except Exception as e:
        logger.error(f"Error during cleanup: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/files/<file_id>/move', methods=['POST'])
@login_required
def move_file_to_folder(file_id):
    """Di chuyển file vào folder"""
    try:
        # Lấy user hiện tại
        user = get_current_user()
        username = user['username']
        user_id = user['id']
        
        data = request.get_json()
        folder_id = data.get('folder_id')
        
        logger.info(f"🔄 Move file request: file_id={file_id}, folder_id={folder_id}, user={username}")
        
        # Cho phép folder_id = null để di chuyển về root
        move_to_root = folder_id is None or folder_id == ""
        
        if not move_to_root and not folder_id:
            return jsonify({"error": "Folder ID is required"}), 400
            
        # Lấy thông tin file từ database
        files = db.get_all_files()
        file_info = None
        for f in files:
            if str(f["id"]) == str(file_id):
                file_info = f
                break
                
        if not file_info:
            logger.error(f"❌ File not found: {file_id}")
            return jsonify({"error": "File not found"}), 404
            
        # Kiểm tra file có thuộc về user này không
        if file_info["user_id"] != user_id:
            logger.error(f"❌ Permission denied: file user_id={file_info['user_id']}, current user_id={user_id}")
            return jsonify({"error": "Permission denied"}), 403
            
        # Lấy thông tin folder (nếu không phải di chuyển về root)
        folder = None
        if not move_to_root:
            legacy_data = load_legacy_db()
            for f in legacy_data["folders"]:
                if f["id"] == folder_id:
                    folder = f
                    break
                    
            if not folder:
                logger.error(f"❌ Folder not found: {folder_id}")
                return jsonify({"error": "Folder not found"}), 404
                
            # Kiểm tra folder có thuộc về user này không (chỉ check nếu folder có user_id)
            folder_user_id = folder.get("user_id")
            if folder_user_id is not None and folder_user_id != user_id:
                logger.error(f"❌ Folder permission denied: folder user_id={folder_user_id}, current user_id={user_id}")
                return jsonify({"error": "Folder permission denied"}), 403
            
        # Xác định đường dẫn file hiện tại
        current_file_path = file_info.get("file_path")
        logger.info(f"📁 Current file_path in DB: {current_file_path}")
        
        # Tìm file trên disk
        possible_paths = []
        if current_file_path:
            possible_paths.append(UPLOAD_FOLDER / current_file_path)
        
        # Thêm các đường dẫn có thể khác
        possible_paths.extend([
            UPLOAD_FOLDER / username / file_info["original_filename"],
            UPLOAD_FOLDER / file_info["original_filename"],
            UPLOAD_FOLDER / username / "root" / file_info["original_filename"]
        ])
        
        current_path = None
        for path in possible_paths:
            logger.info(f"🔍 Checking path: {path}")
            if path.exists():
                current_path = path
                logger.info(f"✅ Found file at: {path}")
                break
        
        if not current_path:
            logger.error(f"❌ File not found on disk. Searched paths: {[str(p) for p in possible_paths]}")
            return jsonify({"error": f"File not found on disk"}), 404
            
        # Xác định đường dẫn đích
        if move_to_root:
            # Di chuyển về root - thư mục username
            target_folder_path = UPLOAD_FOLDER / username
            new_file_path = target_folder_path / file_info["original_filename"]
            new_relative_path = f"{username}/{file_info['original_filename']}"
            target_name = "Root"
            logger.info(f"📂 Moving to root: {target_folder_path}")
        else:
            # Di chuyển vào folder
            folder_path = folder.get("path")
            if not folder_path or folder_path == "None" or folder_path.startswith("None/"):
                # Folder cũ không có path đúng, tạo path mới
                folder_path = f"{username}/{folder['name']}"
            elif not folder_path.startswith(f"{username}/"):
                # Path không có username prefix, thêm vào
                folder_path = f"{username}/{folder['name']}"
                
            target_folder_path = UPLOAD_FOLDER / folder_path
            new_file_path = target_folder_path / file_info["original_filename"]
            new_relative_path = str(new_file_path.relative_to(UPLOAD_FOLDER))
            target_name = folder['name']
            logger.info(f"📂 Moving to folder: {target_folder_path}")
            
        logger.info(f"📄 New file path: {new_file_path}")
        
        # Tạo thư mục đích
        target_folder_path.mkdir(parents=True, exist_ok=True)
        
        # Kiểm tra file đích đã tồn tại chưa
        if new_file_path.exists():
            # Nếu file đích đã tồn tại và khác với file nguồn, tạo tên mới
            if new_file_path.resolve() != current_path.resolve():
                # Tạo tên file mới với timestamp để tránh trùng lặp
                from datetime import datetime
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                name_parts = file_info["original_filename"].rsplit('.', 1)
                if len(name_parts) == 2:
                    new_filename = f"{name_parts[0]}_{timestamp}.{name_parts[1]}"
                else:
                    new_filename = f"{file_info['original_filename']}_{timestamp}"
                
                new_file_path = target_folder_path / new_filename
                new_relative_path = str(new_file_path.relative_to(UPLOAD_FOLDER))
                logger.info(f"📝 File exists, using new name: {new_filename}")
            else:
                # Nếu là cùng một file (chỉ là symbolic link hoặc hardlink), bỏ qua
                logger.info(f"✅ Source and destination are the same file, operation completed")
                return jsonify({
                    "success": True,
                    "message": f"File is already in {target_name}"
                })
            
        # Di chuyển file
        shutil.move(str(current_path), str(new_file_path))
        logger.info(f"✅ File moved successfully from {current_path} to {new_file_path}")
        
        # Cập nhật database với path tương đối
        success = db.update_file_path(file_id, new_relative_path)
        
        if not success:
            logger.error(f"❌ Failed to update database for file {file_id}")
            # Rollback: move file back
            shutil.move(str(new_file_path), str(current_path))
            return jsonify({"error": "Failed to update database"}), 500
            
        # Cập nhật folder_id trong database
        # Nếu di chuyển về root thì folder_id = null
        target_folder_id = None if move_to_root else folder_id
        db.update_file_folder(file_id, target_folder_id)
        
        logger.info(f"✅ File {file_info['original_filename']} moved successfully to {target_name}")
        return jsonify({
            "success": True,
            "message": f"File moved to {target_name} successfully"
        })
            
    except Exception as e:
        logger.error(f"❌ Error moving file: {e}")
        import traceback
        logger.error(f"❌ Traceback: {traceback.format_exc()}")
        return jsonify({"error": str(e)}), 500

# ============ ADMIN API ROUTES ============

@app.route('/api/admin/stats', methods=['GET'])
@login_required
@admin_required
def admin_get_stats():
    """API lấy thống kê tổng quan cho admin"""
    try:
        # Lấy tất cả users
        users = auth_db.get_all_users()
        
        # Lấy tất cả files
        all_files = db.get_all_files()
        
        # Tính toán stats
        total_users = len(users)
        total_files = len(all_files)
        total_size = sum(f.get('size', 0) or 0 for f in all_files if f.get('status') == 'completed')
        
        # Files upload hôm nay
        from datetime import datetime, date
        today = date.today().isoformat()
        today_uploads = len([f for f in all_files if f.get('created_at', '').startswith(today)])
        
        return jsonify({
            'total_users': total_users,
            'total_files': total_files,
            'total_size': total_size,
            'today_uploads': today_uploads,
            'active_users': len([u for u in users if u.get('last_login')]),
            'completed_files': len([f for f in all_files if f.get('status') == 'completed'])
        })
    except Exception as e:
        logger.error(f"Error getting admin stats: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/admin/users', methods=['GET'])
@login_required
@admin_required
def admin_get_users():
    """API lấy danh sách tất cả users cho admin"""
    try:
        users = auth_db.get_all_users()
        return jsonify(users)
    except Exception as e:
        logger.error(f"Error getting users: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/admin/users', methods=['POST'])
@login_required
@admin_required
def admin_create_user():
    """API tạo user mới cho admin"""
    try:
        data = request.get_json()
        username = data.get('username')
        password = data.get('password')
        role = data.get('role', 'user')
        
        if not username or not password:
            return jsonify({'error': 'Username and password required'}), 400
        
        if role not in ['user', 'admin']:
            return jsonify({'error': 'Invalid role'}), 400
        
        user_id = auth_db.create_user(username, password, role)
        if user_id:
            return jsonify({
                'success': True,
                'user_id': user_id,
                'message': 'User created successfully'
            })
        else:
            return jsonify({'error': 'Username already exists'}), 409
    except Exception as e:
        logger.error(f"Error creating user: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/admin/users/<int:user_id>', methods=['DELETE'])
@login_required
@admin_required
def admin_delete_user(user_id):
    """API xóa user cho admin"""
    try:
        current_user = get_current_user()
        if current_user['id'] == user_id:
            return jsonify({'error': 'Cannot delete yourself'}), 400
        
        success = auth_db.delete_user(user_id)
        if success:
            return jsonify({'success': True, 'message': 'User deleted successfully'})
        else:
            return jsonify({'error': 'User not found'}), 404
    except Exception as e:
        logger.error(f"Error deleting user: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/admin/users/<int:user_id>/reset-password', methods=['POST'])
@login_required
@admin_required
def admin_reset_password(user_id):
    """API reset password cho admin"""
    try:
        data = request.get_json()
        new_password = data.get('password')
        
        if not new_password:
            return jsonify({'error': 'New password required'}), 400
        
        success = auth_db.reset_password(user_id, new_password)
        if success:
            return jsonify({'success': True, 'message': 'Password reset successfully'})
        else:
            return jsonify({'error': 'User not found'}), 404
    except Exception as e:
        logger.error(f"Error resetting password: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/admin/files', methods=['GET'])
@login_required
@admin_required
def admin_get_files():
    """API lấy danh sách tất cả files cho admin"""
    try:
        all_files = db.get_all_files()
        
        # Lấy thông tin user cho mỗi file
        users = {user['id']: user for user in auth_db.get_all_users()}
        
        # Thêm username vào file info
        for file in all_files:
            user_id = file.get('user_id')
            if user_id and user_id in users:
                file['username'] = users[user_id]['username']
            else:
                file['username'] = 'Unknown'
        
        return jsonify(all_files)
    except Exception as e:
        logger.error(f"Error getting admin files: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/admin/files/<int:file_id>', methods=['DELETE'])
@login_required
@admin_required
def admin_delete_file(file_id):
    """API xóa file cho admin - di chuyển vào recycle bin"""
    try:
        current_user = get_current_user()
        if not current_user:
            logger.error("❌ Current user not found in admin_delete_file")
            return jsonify({'error': 'User not found'}), 401
        
        logger.info(f"🗑️ ADMIN DELETE FILE - User: {current_user['username']} (ID: {current_user['id']}) deleting file ID: {file_id}")
        
        # Di chuyển file vào recycle bin thay vì xóa ngay
        success = db.move_to_recycle_bin(file_id, current_user['id'], days_to_keep=30)
        if success:
            logger.info(f"✅ File {file_id} moved to recycle bin successfully by admin {current_user['username']}")
            return jsonify({'success': True, 'message': 'File moved to recycle bin successfully'})
        else:
            logger.error(f"❌ Failed to move file {file_id} to recycle bin")
            return jsonify({'error': 'Failed to move file to recycle bin'}), 500
    except Exception as e:
        logger.error(f"Error moving admin file to recycle bin: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/test-simple')
def test_simple():
    logger.info("🔥 SIMPLE TEST ENDPOINT HIT!")
    return "TEST OK!"

# ==================== RECYCLE BIN API ENDPOINTS ====================

@app.route('/api/recycle-bin/test', methods=['GET'])
def test_recycle_bin():
    """Test endpoint để kiểm tra recycle bin"""
    try:
        logger.info("🧪 TEST RECYCLE BIN ENDPOINT CALLED")
        
        # Test database connection
        with sqlite3.connect(db.db_path) as conn:
            cursor = conn.execute("SELECT COUNT(*) FROM recycle_bin")
            total_count = cursor.fetchone()[0]
            
            cursor = conn.execute("SELECT COUNT(*) FROM recycle_bin WHERE status = 'in_recycle'")
            active_count = cursor.fetchone()[0]
            
            # Get sample data
            cursor = conn.execute("""
                SELECT id, original_filename, user_id, deleted_at
                FROM recycle_bin 
                WHERE status = 'in_recycle'
                ORDER BY deleted_at DESC
                LIMIT 3
            """)
            sample_files = cursor.fetchall()
        
        result = {
            'success': True,
            'total_files_in_recycle': total_count,
            'active_files_in_recycle': active_count,
            'sample_files': [
                {
                    'id': f[0],
                    'filename': f[1], 
                    'user_id': f[2],
                    'deleted_at': f[3]
                } for f in sample_files
            ]
        }
        
        logger.info(f"🧪 TEST RESULT: {result}")
        return jsonify(result)
        
    except Exception as e:
        logger.error(f"🧪 TEST ERROR: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/recycle-bin', methods=['GET'])
@login_required
def get_recycle_bin():
    """API lấy danh sách file trong thùng rác của user"""
    try:
        current_user = get_current_user()
        if not current_user:
            logger.error("❌ Current user not found in get_recycle_bin")
            return jsonify({'error': 'User not found'}), 401
        
        logger.info(f"🗑️ GET RECYCLE BIN - User: {current_user['username']} (ID: {current_user['id']}) Role: {current_user.get('role', 'user')}")
        
        # Admin có thể xem tất cả files, user chỉ xem của mình
        if current_user.get('role') == 'admin':
            files = db.get_recycle_bin_files()  # Admin xem tất cả
            logger.info(f"🗑️ ADMIN - Found {len(files)} total files in recycle bin")
        else:
            files = db.get_recycle_bin_files(current_user['id'])  # User xem của mình
            logger.info(f"🗑️ USER - Found {len(files)} files in recycle bin for user {current_user['id']}")
        
        for file in files:
            logger.info(f"  - File: {file['original_filename']} (ID: {file['id']}) Owner: {file.get('user_id', 'Unknown')}")
        
        return jsonify({'files': files})
    except Exception as e:
        logger.error(f"Error getting recycle bin: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/admin/recycle-bin', methods=['GET'])
@login_required
@admin_required
def admin_get_recycle_bin():
    """API admin lấy tất cả file trong thùng rác"""
    try:
        files = db.get_recycle_bin_files()  # Admin thấy tất cả
        return jsonify({'files': files})
    except Exception as e:
        logger.error(f"Error getting admin recycle bin: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/recycle-bin/<int:recycle_id>/restore', methods=['POST'])
@login_required
def restore_file(recycle_id):
    """API khôi phục file từ thùng rác"""
    try:
        current_user = get_current_user()
        if not current_user:
            return jsonify({'error': 'User not found'}), 401
        user_id = None if current_user.get('role') == 'admin' else current_user['id']
        
        success = db.restore_from_recycle_bin(recycle_id, user_id)
        if success:
            return jsonify({'success': True, 'message': 'File restored successfully'})
        else:
            return jsonify({'error': 'Failed to restore file or file not found'}), 404
    except Exception as e:
        logger.error(f"Error restoring file: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/files/<int:file_id>', methods=['DELETE'])
@login_required
def delete_user_file(file_id):
    """API xóa file của user - di chuyển vào recycle bin"""
    try:
        current_user = get_current_user()
        if not current_user:
            return jsonify({'error': 'User not found'}), 401
        
        # Kiểm tra quyền sở hữu file
        file_info = db.get_file_by_id(file_id)
        if not file_info:
            return jsonify({'error': 'File not found'}), 404
        
        # User chỉ có thể xóa file của mình, admin xóa được tất cả
        if current_user.get('role') != 'admin' and file_info.get('user_id') != current_user['id']:
            return jsonify({'error': 'Permission denied'}), 403
        
        # Di chuyển file vào recycle bin
        success = db.move_to_recycle_bin(file_id, current_user['id'], days_to_keep=7)  # User file giữ 7 ngày
        if success:
            return jsonify({'success': True, 'message': 'File moved to recycle bin successfully'})
        else:
            return jsonify({'error': 'Failed to move file to recycle bin'}), 500
    except Exception as e:
        logger.error(f"Error moving user file to recycle bin: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/files/<int:file_id>/rename', methods=['PATCH'])
@login_required
def rename_file(file_id):
    """API đổi tên file"""
    try:
        current_user = get_current_user()
        if not current_user:
            return jsonify({'error': 'User not found'}), 401
        
        # Lấy dữ liệu từ request
        data = request.get_json()
        new_name = data.get('new_name', '').strip()
        
        if not new_name:
            return jsonify({'error': 'New file name is required'}), 400
        
        # Validate tên file
        invalid_chars = r'[<>:"/\\|?*]'
        if re.search(invalid_chars, new_name):
            return jsonify({'error': 'Invalid characters in file name: < > : " / \\ | ? *'}), 400
        
        # Kiểm tra quyền sở hữu file
        file_info = db.get_file_by_id(file_id)
        if not file_info:
            return jsonify({'error': 'File not found'}), 404
        
        # User chỉ có thể đổi tên file của mình, admin có thể đổi tên tất cả
        if current_user.get('role') != 'admin' and file_info.get('user_id') != current_user['id']:
            return jsonify({'error': 'Permission denied'}), 403
        
        # Lấy đường dẫn file hiện tại
        old_file_path = UPLOAD_FOLDER / file_info['file_path']
        old_name = file_info['original_filename']
        
        logger.info(f"🔧 Rename file ID {file_id}: '{old_name}' -> '{new_name}'")
        logger.info(f"🔧 Old file path: {old_file_path}")
        
        # Tạo tên file mới với extension cũ nếu có
        old_name_parts = old_name.rsplit('.', 1)
        if len(old_name_parts) > 1:
            # Có extension
            old_extension = old_name_parts[1]
            new_name_parts = new_name.rsplit('.', 1)
            if len(new_name_parts) == 1 or new_name_parts[1] != old_extension:
                # Thêm extension cũ nếu người dùng không nhập hoặc nhập sai
                new_name = f"{new_name}.{old_extension}"
                logger.info(f"🔧 Auto-added extension: {new_name}")
        
        # Tạo đường dẫn file mới
        directory = old_file_path.parent
        new_file_path = directory / new_name
        
        logger.info(f"🔧 New file path: {new_file_path}")
        logger.info(f"🔧 Old path exists: {old_file_path.exists()}")
        logger.info(f"🔧 New path exists: {new_file_path.exists()}")
        logger.info(f"🔧 Paths are same: {new_file_path == old_file_path}")
        
        # Kiểm tra case-insensitive trên Windows
        old_path_str = str(old_file_path).lower()
        new_path_str = str(new_file_path).lower()
        logger.info(f"🔧 Case-insensitive comparison: {old_path_str} vs {new_path_str}")
        logger.info(f"🔧 Case-insensitive same: {old_path_str == new_path_str}")
        
        # Nếu tên file giống nhau (case-insensitive), cho phép rename
        if old_path_str == new_path_str:
            logger.info(f"🔧 Same filename case-insensitive, allowing rename for case change")
        else:
            # Khác tên -> kiểm tra trung lặp
            if new_file_path.exists():
                logger.warning(f"🔧 File already exists at {new_file_path}")
                return jsonify({'error': 'A file with this name already exists'}), 409
            
            # Kiểm tra trong database xem có file nào khác có tên giống (case-insensitive)
            user_files = db.get_user_files(current_user['id'])
            for user_file in user_files:
                if (user_file['id'] != file_id and 
                    user_file['original_filename'].lower() == new_name.lower()):
                    logger.warning(f"🔧 Another file in database has same name: {user_file['original_filename']}")
                    return jsonify({'error': 'A file with this name already exists'}), 409
        
        # Đổi tên file vật lý
        if old_file_path.exists():
            old_file_path.rename(new_file_path)
            logger.info(f"File renamed from {old_file_path} to {new_file_path}")
        
        # Cập nhật database
        relative_new_path = str(new_file_path.relative_to(UPLOAD_FOLDER))
        # Chuẩn hóa path separator cho cross-platform compatibility
        relative_new_path_normalized = relative_new_path.replace('\\', '/')
        
        success = db.update_file_name(file_id, new_name, relative_new_path_normalized)
        
        if success:
            logger.info(f"🔧 Successfully renamed file ID {file_id} to '{new_name}' at path '{relative_new_path_normalized}'")
            return jsonify({
                'success': True, 
                'message': 'File renamed successfully',
                'new_name': new_name,
                'new_path': relative_new_path_normalized
            })
        else:
            # Rollback file rename nếu database update thất bại
            if new_file_path.exists():
                new_file_path.rename(old_file_path)
            return jsonify({'error': 'Failed to update database'}), 500
            
    except Exception as e:
        logger.error(f"Error renaming file: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/recycle-bin/<int:recycle_id>/delete', methods=['DELETE'])
@login_required
def permanently_delete_file(recycle_id):
    """API xóa vĩnh viễn file từ thùng rác"""
    try:
        current_user = get_current_user()
        if not current_user:
            return jsonify({'error': 'User not found'}), 401
        user_id = None if current_user.get('role') == 'admin' else current_user['id']
        
        success, file_path = db.permanently_delete_from_recycle(recycle_id, user_id)
        if success:
            # Xóa file vật lý
            if file_path:
                physical_path = UPLOAD_FOLDER / file_path
                if physical_path.exists():
                    physical_path.unlink()
                    logger.info(f"Physical file deleted: {physical_path}")
            
            return jsonify({'success': True, 'message': 'File permanently deleted'})
        else:
            return jsonify({'error': 'Failed to delete file or file not found'}), 404
    except Exception as e:
        logger.error(f"Error permanently deleting file: {e}")
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
