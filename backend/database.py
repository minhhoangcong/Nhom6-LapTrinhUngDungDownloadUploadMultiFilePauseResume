import sqlite3
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path
import logging

# Timezone Việt Nam (UTC+7)
VIETNAM_TZ = timezone(timedelta(hours=7))

def get_vietnam_time():
    """Lấy thời gian hiện tại theo timezone Việt Nam"""
    return datetime.now(VIETNAM_TZ)

def vietnam_now_isoformat():
    """Trả về thời gian Việt Nam dưới dạng ISO format"""
    return get_vietnam_time().isoformat()

logger = logging.getLogger(__name__)

class FileDatabase:
    def __init__(self, db_path="files.db"):
        self.db_path = db_path
        self.init_database()
    
    def init_database(self):
        """Khởi tạo database và tạo bảng files với user support"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                # Cập nhật bảng files để support user_id
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS files (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        filename TEXT NOT NULL,
                        original_filename TEXT NOT NULL,
                        size INTEGER NOT NULL,
                        uploader TEXT DEFAULT 'Anonymous',
                        user_id INTEGER,
                        status TEXT DEFAULT 'uploading',
                        file_path TEXT,
                        temp_path TEXT,
                        folder_id TEXT,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """)
                
                # Tạo bảng recycle_bin để quản lý file đã xóa
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS recycle_bin (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        original_file_id INTEGER NOT NULL,
                        filename TEXT NOT NULL,
                        original_filename TEXT NOT NULL,
                        size INTEGER NOT NULL,
                        user_id INTEGER,
                        file_path TEXT NOT NULL,
                        deleted_by INTEGER,
                        deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        restore_deadline TIMESTAMP,
                        status TEXT DEFAULT 'in_recycle',
                        FOREIGN KEY (user_id) REFERENCES users (id),
                        FOREIGN KEY (deleted_by) REFERENCES users (id)
                    )
                """)
                
                # Tạo index để tăng tốc truy vấn
                conn.execute("CREATE INDEX IF NOT EXISTS idx_status ON files(status)")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_filename ON files(filename)")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_user_id ON files(user_id)")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_recycle_user ON recycle_bin(user_id)")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_recycle_status ON recycle_bin(status)")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_recycle_deadline ON recycle_bin(restore_deadline)")
                conn.commit()
                logger.info("Database initialized successfully")
        except sqlite3.Error as e:
            logger.error(f"Database initialization error: {e}")
            raise
    
    def add_file(self, filename, original_filename, size, uploader="Anonymous", user_id=None, temp_path=None, folder_id=None):
        """Thêm file mới vào database với user context"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.execute("""
                    INSERT INTO files (filename, original_filename, size, uploader, user_id, status, temp_path, folder_id, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, 'uploading', ?, ?, ?, ?)
                """, (filename, original_filename, size, uploader, user_id, temp_path, folder_id, vietnam_now_isoformat(), vietnam_now_isoformat()))
                
                file_id = cursor.lastrowid
                conn.commit()
                logger.info(f"File added to database: {original_filename} (ID: {file_id})")
                return file_id
        except sqlite3.Error as e:
            logger.error(f"Error adding file to database: {e}")
            raise
    
    def update_file_status(self, file_id, status, file_path=None):
        """Cập nhật trạng thái file"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                if file_path:
                    conn.execute("""
                        UPDATE files 
                        SET status = ?, file_path = ?, updated_at = ?
                        WHERE id = ?
                    """, (status, file_path, vietnam_now_isoformat(), file_id))
                else:
                    conn.execute("""
                        UPDATE files 
                        SET status = ?, updated_at = ?
                        WHERE id = ?
                    """, (status, vietnam_now_isoformat(), file_id))
                
                conn.commit()
                logger.info(f"File status updated: ID {file_id} -> {status}")
                return True
        except sqlite3.Error as e:
            logger.error(f"Error updating file status: {e}")
            return False
    
    def get_file_by_id(self, file_id):
        """Lấy thông tin file theo ID"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.row_factory = sqlite3.Row
                cursor = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,))
                result = cursor.fetchone()
                return dict(result) if result else None
        except sqlite3.Error as e:
            logger.error(f"Error getting file by ID: {e}")
            return None
    
    def get_file_by_filename(self, filename):
        """Lấy thông tin file theo tên file"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.row_factory = sqlite3.Row
                cursor = conn.execute("SELECT * FROM files WHERE filename = ?", (filename,))
                result = cursor.fetchone()
                return dict(result) if result else None
        except sqlite3.Error as e:
            logger.error(f"Error getting file by filename: {e}")
            return None
    
    def get_username_by_id(self, user_id):
        """Lấy username từ auth database theo user_id"""
        if not user_id:
            return None
            
        try:
            auth_db_path = os.path.join(os.path.dirname(self.db_path), "auth.db")
            with sqlite3.connect(auth_db_path) as conn:
                cursor = conn.execute("SELECT username FROM users WHERE id = ?", (user_id,))
                result = cursor.fetchone()
                return result[0] if result else None
        except sqlite3.Error as e:
            logger.error(f"Error getting username by ID {user_id}: {e}")
            return None
    
    def get_all_files(self, status=None, limit=None, offset=0, user_id=None):
        """Lấy danh sách files theo user (nếu user_id được cung cấp)"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.row_factory = sqlite3.Row
                
                # Build query với user filtering
                where_conditions = ["status != 'deleted'"]
                params = []
                
                if status:
                    where_conditions.append("status = ?")
                    params.append(status)
                
                if user_id is not None:
                    where_conditions.append("user_id = ?")
                    params.append(user_id)
                
                # Build complete query
                query = "SELECT * FROM files"
                if where_conditions:
                    query += " WHERE " + " AND ".join(where_conditions)
                query += " ORDER BY created_at DESC"
                
                if limit:
                    query += " LIMIT ? OFFSET ?"
                    params.extend([limit, offset])
                
                logger.info(f"Executing query: {query} with params: {params}")
                cursor = conn.execute(query, params)
                results = cursor.fetchall()
                logger.info(f"Query returned {len(results)} files")           
                for i, row in enumerate(results[:3]):
                    logger.info(f"File {i+1}: ID={row['id']}, filename={row['filename']}, user_id={row['user_id']}, status={row['status']}")
                
                return [dict(row) for row in results]
        except sqlite3.Error as e:
            logger.error(f"Error getting files: {e}")
            return []
    
    def get_user_files(self, user_id, status=None):
        """Lấy tất cả files của một user cụ thể"""
        return self.get_all_files(status=status, user_id=user_id) 
    def get_files_by_folder(self, folder_id, user_id=None):
        """Lấy tất cả files trong một folder cụ thể"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.row_factory = sqlite3.Row
                
                if user_id:
                    cursor = conn.execute("""
                        SELECT * FROM files 
                        WHERE folder_id = ? AND user_id = ? AND status != 'deleted'
                        ORDER BY created_at DESC
                    """, (folder_id, user_id))
                else:
                    cursor = conn.execute("""
                        SELECT * FROM files 
                        WHERE folder_id = ? AND status != 'deleted'
                        ORDER BY created_at DESC
                    """, (folder_id,))
                
                files = [dict(row) for row in cursor.fetchall()]
                logger.info(f"Found {len(files)} files in folder {folder_id} for user {user_id}")
                return files
                
        except sqlite3.Error as e:
            logger.error(f"Error getting files by folder: {e}")
            return []
    
    def delete_file(self, file_id):
        """Xóa file khỏi database"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.execute("DELETE FROM files WHERE id = ?", (file_id,))
                conn.commit()
                
                if cursor.rowcount > 0:
                    logger.info(f"File deleted from database: ID {file_id}")
                    return True
                else:
                    logger.warning(f"File not found in database: ID {file_id}")
                    return False
        except sqlite3.Error as e:
            logger.error(f"Error deleting file: {e}")
            return False
    
    def get_file_stats(self):
        """Lấy thống kê files"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.execute("""
                    SELECT 
                        COUNT(*) as total_files,
                        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_files,
                        COUNT(CASE WHEN status = 'uploading' THEN 1 END) as uploading_files,
                        COUNT(CASE WHEN status = 'paused' THEN 1 END) as paused_files,
                        COALESCE(SUM(CASE WHEN status = 'completed' THEN size ELSE 0 END), 0) as total_size
                    FROM files
                """)
                
                result = cursor.fetchone()
                return {
                    'total_files': result[0],
                    'completed_files': result[1],
                    'uploading_files': result[2],
                    'paused_files': result[3],
                    'total_size': result[4]
                }
        except sqlite3.Error as e:
            logger.error(f"Error getting file stats: {e}")
            return {
                'total_files': 0,
                'completed_files': 0,
                'uploading_files': 0,
                'paused_files': 0,
                'total_size': 0
            }
    
    def get_file_by_id(self, file_id):
        """Lấy thông tin file theo ID"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.row_factory = sqlite3.Row
                cursor = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,))
                result = cursor.fetchone()
                return dict(result) if result else None
        except sqlite3.Error as e:
            logger.error(f"Error getting file by ID: {e}")
            return None
    
    def update_file_path(self, file_id, new_path):
        """Cập nhật đường dẫn file"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.execute("""
                    UPDATE files 
                    SET file_path = ?, updated_at = CURRENT_TIMESTAMP 
                    WHERE id = ?
                """, (new_path, file_id))
                conn.commit()
                
                if conn.total_changes > 0:
                    logger.info(f"Updated file path for ID {file_id}: {new_path}")
                    return True
                else:
                    logger.warning(f"File not found for path update: ID {file_id}")
                    return False
        except sqlite3.Error as e:
            logger.error(f"Error updating file path: {e}")
            return False
    
    def update_file_folder(self, file_id, folder_id):
        """Cập nhật folder_id của file"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.execute("""
                    UPDATE files 
                    SET folder_id = ?, updated_at = CURRENT_TIMESTAMP 
                    WHERE id = ?
                """, (folder_id, file_id))
                conn.commit()
                
                if conn.total_changes > 0:
                    logger.info(f"Updated file folder for ID {file_id}: {folder_id}")
                    return True
                else:
                    logger.warning(f"File not found for folder update: ID {file_id}")
                    return False
        except sqlite3.Error as e:
            logger.error(f"Error updating file folder: {e}")
            return False

    def update_file_name(self, file_id, new_name, new_path):
        """Cập nhật tên file và đường dẫn file"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.execute("""
                    UPDATE files 
                    SET original_filename = ?, file_path = ?, updated_at = CURRENT_TIMESTAMP 
                    WHERE id = ?
                """, (new_name, new_path, file_id))
                conn.commit()
                
                if conn.total_changes > 0:
                    logger.info(f"Updated file name for ID {file_id}: {new_name} -> {new_path}")
                    return True
                else:
                    logger.warning(f"File not found for name update: ID {file_id}")
                    return False
        except sqlite3.Error as e:
            logger.error(f"Error updating file name: {e}")
            return False
    
    def cleanup_temp_files(self):
        """Dọn dẹp các file tạm cũ (có thể chạy định kỳ)"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.execute("""
                    DELETE FROM files 
                    WHERE status = 'uploading' 
                    AND datetime(created_at) < datetime('now', '-1 day')
                """)
                
                deleted_count = conn.total_changes
                conn.commit()
                
                if deleted_count > 0:
                    logger.info(f"Cleaned up {deleted_count} old temp files")
                
                return deleted_count
        except sqlite3.Error as e:
            logger.error(f"Error cleaning up temp files: {e}")
            return 0
    
    def move_to_recycle_bin(self, file_id, deleted_by_user_id, days_to_keep=30):
        """Di chuyển file vào thùng rác"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                # Lấy thông tin file
                cursor = conn.execute("""
                    SELECT filename, original_filename, size, user_id, file_path 
                    FROM files WHERE id = ?
                """, (file_id,))
                
                file_info = cursor.fetchone()
                if not file_info:
                    return False
                
                filename, original_filename, size, user_id, file_path = file_info
                
                # Tính restore deadline với timezone Việt Nam
                vietnam_time = get_vietnam_time()
                restore_deadline = vietnam_time + timedelta(days=days_to_keep)
                
                # Thêm vào recycle_bin với restore deadline chính xác
                conn.execute("""
                    INSERT INTO recycle_bin 
                    (original_file_id, filename, original_filename, size, user_id, 
                     file_path, deleted_by, deleted_at, restore_deadline) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, 
                (file_id, filename, original_filename, size, user_id, file_path, deleted_by_user_id, 
                 vietnam_time.isoformat(), restore_deadline.isoformat()))
                
                # Xóa khỏi bảng files chính
                conn.execute("DELETE FROM files WHERE id = ?", (file_id,))
                conn.commit()
                
                logger.info(f"File moved to recycle bin: ID {file_id}")
                return True
                
        except sqlite3.Error as e:
            logger.error(f"Error moving file to recycle bin: {e}")
            return False
    
    def get_recycle_bin_files(self, user_id=None):
        """Lấy danh sách file trong thùng rác với username thật"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                if user_id:
                    cursor = conn.execute("""
                        SELECT r.id, r.original_file_id, r.filename, r.original_filename, 
                               r.size, r.user_id, r.file_path, r.deleted_at, r.restore_deadline,
                               r.status, r.deleted_by
                        FROM recycle_bin r 
                        WHERE r.user_id = ? AND r.status = 'in_recycle'
                        ORDER BY r.deleted_at DESC
                    """, (user_id,))
                else:
                    cursor = conn.execute("""
                        SELECT r.id, r.original_file_id, r.filename, r.original_filename, 
                               r.size, r.user_id, r.file_path, r.deleted_at, r.restore_deadline,
                               r.status, r.deleted_by
                        FROM recycle_bin r 
                        WHERE r.status = 'in_recycle'
                        ORDER BY r.deleted_at DESC
                    """)
                
                files = []
                for row in cursor.fetchall():
                    # Lấy username thật từ auth database
                    owner_username = self.get_username_by_id(row[5])
                    deleted_by_username = self.get_username_by_id(row[10]) if row[10] else None
                    
                    files.append({
                        'id': row[0],
                        'original_file_id': row[1],
                        'filename': row[2],
                        'original_filename': row[3],
                        'size': row[4],
                        'user_id': row[5],
                        'file_path': row[6],
                        'deleted_at': row[7],
                        'restore_deadline': row[8],
                        'status': row[9],
                        'deleted_by': row[10],
                        'owner_name': owner_username or f'User_{row[5]}',  # Username thật hoặc fallback
                        'deleted_by_name': deleted_by_username or f'User_{row[10]}' if row[10] else None
                    })
                
                return files
                
                return files
                
        except sqlite3.Error as e:
            logger.error(f"Error getting recycle bin files: {e}")
            return []
    
    def restore_from_recycle_bin(self, recycle_id, user_id=None):
        """Khôi phục file từ thùng rác"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                # Lấy thông tin file từ recycle_bin
                query = """
                    SELECT original_file_id, filename, original_filename, size, 
                           user_id, file_path, deleted_at 
                    FROM recycle_bin 
                    WHERE id = ? AND status = 'in_recycle'
                """
                params = [recycle_id]
                
                # Nếu không phải admin, chỉ cho phép restore file của chính mình
                if user_id:
                    query += " AND user_id = ?"
                    params.append(user_id)
                
                cursor = conn.execute(query, params)
                file_info = cursor.fetchone()
                
                if not file_info:
                    return False
                
                original_file_id, filename, original_filename, size, owner_id, file_path, deleted_at = file_info
                
                # Thêm lại vào bảng files chính
                conn.execute("""
                    INSERT INTO files 
                    (filename, original_filename, size, user_id, status, file_path, created_at, updated_at) 
                    VALUES (?, ?, ?, ?, 'completed', ?, ?, CURRENT_TIMESTAMP)
                """, (filename, original_filename, size, owner_id, file_path, deleted_at))
                
                # Đánh dấu trong recycle_bin là đã restore
                conn.execute("""
                    UPDATE recycle_bin SET status = 'restored' WHERE id = ?
                """, (recycle_id,))
                
                conn.commit()
                logger.info(f"File restored from recycle bin: ID {recycle_id}")
                return True
                
        except sqlite3.Error as e:
            logger.error(f"Error restoring file from recycle bin: {e}")
            return False
    
    def permanently_delete_from_recycle(self, recycle_id, user_id=None):
        """Xóa vĩnh viễn file từ thùng rác"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                query = """
                    SELECT file_path FROM recycle_bin 
                    WHERE id = ? AND status = 'in_recycle'
                """
                params = [recycle_id]
                
                # Nếu không phải admin, chỉ cho phép xóa file của chính mình
                if user_id:
                    query += " AND user_id = ?"
                    params.append(user_id)
                
                cursor = conn.execute(query, params)
                file_info = cursor.fetchone()
                
                if not file_info:
                    return False, None
                
                file_path = file_info[0]
                
                # Đánh dấu là đã xóa vĩnh viễn
                conn.execute("""
                    UPDATE recycle_bin SET status = 'permanently_deleted' WHERE id = ?
                """, (recycle_id,))
                
                conn.commit()
                logger.info(f"File permanently deleted from recycle bin: ID {recycle_id}")
                return True, file_path
                
        except sqlite3.Error as e:
            logger.error(f"Error permanently deleting file from recycle bin: {e}")
            return False, None
    
    def cleanup_expired_recycle_files(self):
        """Dọn dẹp các file hết hạn trong thùng rác"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                # Lấy danh sách file hết hạn
                cursor = conn.execute("""
                    SELECT id, file_path FROM recycle_bin 
                    WHERE status = 'in_recycle' 
                    AND restore_deadline < datetime('now')
                """)
                
                expired_files = cursor.fetchall()
                
                # Đánh dấu các file hết hạn
                conn.execute("""
                    UPDATE recycle_bin 
                    SET status = 'expired' 
                    WHERE status = 'in_recycle' 
                    AND restore_deadline < datetime('now')
                """)
                
                conn.commit()
                logger.info(f"Marked {len(expired_files)} expired recycle bin files")
                return expired_files
                
        except sqlite3.Error as e:
            logger.error(f"Error cleaning up expired recycle files: {e}")
            return []

db = FileDatabase()
