from flask import Flask, render_template, request, jsonify, send_file, abort, session, redirect, url_for
from flask_cors import CORS
import os
import json
import uuid
from datetime import datetime
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
CORS(app, supports_credentials=True)
app.secret_key = 'your-secret-key-change-in-production'  # Thay đổi trong production

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
        if token and token.startswith('Bearer '):
            token = token[7:]  # Remove 'Bearer ' prefix
            user = auth_db.get_user_by_token(token)
            if user:
                request.current_user = user
                return f(*args, **kwargs)
        
        # Kiểm tra session cookie
        if 'user_token' in session:
            user = auth_db.get_user_by_token(session['user_token'])
            if user:
                request.current_user = user
                return f(*args, **kwargs)
        
        return jsonify({'error': 'Authentication required'}), 401
    return decorated_function

def get_current_user():
    """Lấy thông tin user hiện tại"""
    if hasattr(request, 'current_user'):
        return request.current_user
    return None

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

# Authentication API Routes
@app.route('/api/login', methods=['POST'])
def login():
    """API đăng nhập"""
    try:
        data = request.get_json()
        username = data.get('username')
        password = data.get('password')
        
        if not username or not password:
            return jsonify({'error': 'Username and password required'}), 400
        
        # Xác thực user
        user = auth_db.authenticate_user(username, password)
        if user:
            # Tạo session token
            token = auth_db.create_session(user['id'])
            session['user_token'] = token
            
            return jsonify({
                'success': True,
                'user': user,
                'token': token
            })
        else:
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
        
        # Tạo đường dẫn file với user folder
        user_folder = UPLOAD_FOLDER / f"user_{user['id']}"
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
            
            # Cập nhật status thành completed
            db.update_file_status(
                file_id=file_db_id,
                status="completed"
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

@app.route('/api/files', methods=['GET'])
@login_required
def get_files():
    """Lấy danh sách files của user hiện tại từ SQLite database"""
    try:
        user = get_current_user()
        logger.info(f"Getting files for user: {user['id']} ({user['username']})")
        
        # Lấy tham số query
        status = request.args.get('status')  # completed, uploading, paused
        limit = request.args.get('limit', type=int)
        offset = request.args.get('offset', 0, type=int)
        
        # Lấy files của user từ database
        files = db.get_user_files(user['id'], status=status)
        logger.info(f"Found {len(files)} files for user {user['id']}")
        
        # Convert format cho frontend compatibility
        formatted_files = []
        for file in files:
            formatted_files.append({
                "id": file["id"],
                "name": file["original_filename"],
                "filename": file["original_filename"],
                "file_path": file["file_path"],
                "size": file["size"],
                "upload_time": file["created_at"],
                "status": file["status"],
                "uploader": file["uploader"],
                "user_id": file["user_id"],
                "type": "file"
            })
        
        return jsonify(formatted_files)
    except Exception as e:
        logger.error(f"Error getting files: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/folders', methods=['GET'])
@login_required
def get_folders():
    """Lấy danh sách folders của user hiện tại từ legacy database"""
    try:
        user = get_current_user()
        parent_id = request.args.get('parent_id')  # Thêm filter by parent_id
        legacy_data = load_legacy_db()
        
        # Filter folders theo user (tạm thời giữ tất cả folders cho tất cả users)
        # Sau này có thể thêm user_id vào folder structure
        
        if parent_id is not None:
            # Filter folders by parent_id
            if parent_id == "":
                # Root level folders (parent_id is null)
                folders = [f for f in legacy_data["folders"] if f.get("parent_id") is None]
            else:
                # Specific parent folder
                folders = [f for f in legacy_data["folders"] if f.get("parent_id") == parent_id]
            return jsonify(folders)
        else:
            # Return all folders (backward compatibility)
            return jsonify(legacy_data["folders"])
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
def download_file(file_id):
    """Download file từ SQLite database"""
    try:
        file_info = db.get_file_by_id(file_id)
        if file_info:
            # Chỉ cho phép download file đã completed
            if file_info["status"] != "completed":
                return jsonify({"error": "File not ready for download"}), 400
            
            if file_info["file_path"]:
                file_path = UPLOAD_FOLDER / file_info["file_path"]
                if file_path.exists():
                    return send_file(
                        file_path,
                        as_attachment=True,
                        download_name=file_info["original_filename"]
                    )
                else:
                    return jsonify({"error": "File not found on disk"}), 404
            else:
                return jsonify({"error": "File path not available"}), 404
        return jsonify({"error": "File not found"}), 404
    except Exception as e:
        logger.error(f"Error downloading file: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/files/<int:file_id>', methods=['DELETE'])
def delete_file(file_id):
    """Xóa file từ SQLite database và disk"""
    try:
        # Lấy thông tin file trước khi xóa
        file_info = db.get_file_by_id(file_id)
        if not file_info:
            return jsonify({"error": "File not found"}), 404
        
        # Xác định đường dẫn file thật trên disk
        if file_info["file_path"] and file_info["file_path"] != "/" and file_info["file_path"] != "":
            # File trong folder: file_path = "foldername/", actual file = "foldername/filename"
            if file_info["file_path"].endswith("/"):
                folder_name = file_info["file_path"].rstrip("/")
                actual_file_path = UPLOAD_FOLDER / folder_name / file_info["filename"]
            else:
                # File path đầy đủ
                actual_file_path = UPLOAD_FOLDER / file_info["file_path"]
        else:
            # File ở root: lưu trực tiếp với filename
            actual_file_path = UPLOAD_FOLDER / file_info["filename"]
        
        # Xóa file từ disk nếu có
        if actual_file_path.exists():
            actual_file_path.unlink()
            logger.info(f"File deleted from disk: {actual_file_path}")
        else:
            logger.warning(f"File not found on disk: {actual_file_path}")
        
        # Xóa temp file nếu có
        if file_info["temp_path"]:
            temp_path = TEMP_FOLDER / file_info["temp_path"]
            if temp_path.exists():
                temp_path.unlink()
                logger.info(f"Temp file deleted: {temp_path}")
        
        # Xóa khỏi database
        if db.delete_file(file_id):
            logger.info(f"File deleted: {file_info['original_filename']} (ID: {file_id})")
            return jsonify({"success": True, "message": "File deleted successfully"})
        else:
            return jsonify({"error": "Failed to delete from database"}), 500
        
    except Exception as e:
        logger.error(f"Error deleting file: {e}")
        return jsonify({"error": str(e)}), 500