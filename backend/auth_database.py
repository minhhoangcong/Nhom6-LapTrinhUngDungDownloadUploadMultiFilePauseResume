import sqlite3
import hashlib
import secrets
import os
from datetime import datetime
import logging

class AuthDatabase:
    def __init__(self, db_path="auth.db"):
        self.db_path = db_path
        self.init_database()
    
    def init_database(self):
        """Khởi tạo database với các bảng cần thiết"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        # Tạo bảng users
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT DEFAULT 'user',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP
            )
        ''')
        
        # Tạo bảng files (cập nhật từ JSON sang SQL)
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS files (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                original_filename TEXT NOT NULL,
                path TEXT NOT NULL,
                size INTEGER,
                mimetype TEXT,
                user_id INTEGER NOT NULL,
                folder_id TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id),
                FOREIGN KEY (folder_id) REFERENCES folders (id)
            )
        ''')
        
        # Tạo bảng folders (cập nhật từ JSON sang SQL)
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                parent_id TEXT,
                user_id INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id),
                FOREIGN KEY (parent_id) REFERENCES folders (id)
            )
        ''')
        
        # Tạo bảng sessions để quản lý đăng nhập
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                token TEXT UNIQUE NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        ''')
        
        conn.commit()
        conn.close()
        logging.info("Database initialized successfully")
    
    def hash_password(self, password):
        """Hash password với salt"""
        salt = secrets.token_hex(16)
        password_hash = hashlib.pbkdf2_hmac('sha256', 
                                          password.encode('utf-8'), 
                                          salt.encode('utf-8'), 
                                          100000)
        return f"{salt}:{password_hash.hex()}"
    
    def verify_password(self, password, password_hash):
        """Xác thực password - support both custom PBKDF2 and Werkzeug scrypt"""
        from werkzeug.security import check_password_hash
        
        # SECURITY FIX: Do not log sensitive data
        logging.debug("🔐 VERIFY: Checking password authentication")
        
        try:
            # Try Werkzeug first (scrypt format)
            if password_hash.startswith('scrypt:') or password_hash.startswith('pbkdf2:'):
                result = check_password_hash(password_hash, password)
                logging.debug(f"🔐 VERIFY: Werkzeug check result: {result}")
                return result
            
            # Fallback to custom PBKDF2 format (salt:hash)
            elif ':' in password_hash and not password_hash.startswith('scrypt:'):
                salt, stored_hash = password_hash.split(':', 1)
                password_hash_check = hashlib.pbkdf2_hmac('sha256',
                                                        password.encode('utf-8'),
                                                        salt.encode('utf-8'),
                                                        100000)
                result = stored_hash == password_hash_check.hex()
                logging.debug(f"🔐 VERIFY: Custom PBKDF2 check result: {result}")
                return result
            else:
                logging.error(f"🔐 VERIFY: Unknown hash format!")
                return False
        except Exception as e:
            logging.error(f"🔐 VERIFY: Exception during verification: {e}")
            return False
    
    def create_user(self, username, password, role='user'):
        """Tạo user mới"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        try:
            password_hash = self.hash_password(password)
            cursor.execute('''
                INSERT INTO users (username, password_hash, role)
                VALUES (?, ?, ?)
            ''', (username, password_hash, role))
            
            user_id = cursor.lastrowid
            conn.commit()
            logging.info(f"User created: {username} (ID: {user_id})")
            return user_id
        except sqlite3.IntegrityError:
            logging.warning(f"Username already exists: {username}")
            return None
        finally:
            conn.close()
    
    def authenticate_user(self, username, password):
        """Xác thực user login"""
        # SECURITY FIX: Do not log sensitive data
        logging.info(f"🔍 AUTH: Authentication attempt for username: {username}")
        
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT id, username, password_hash, role
            FROM users 
            WHERE username = ?
        ''', (username,))
        
        user = cursor.fetchone()
        logging.debug(f"🔍 AUTH: User found in DB: {user is not None}")
        
        if user:
            logging.debug(f"🔍 AUTH: User details: ID={user[0]}, username='{user[1]}', role='{user[3]}'")
            # SECURITY FIX: Do not log password hash
            
            password_valid = self.verify_password(password, user[2])
            logging.debug(f"🔍 AUTH: Password verification: {password_valid}")
            
            if password_valid:
                conn.close()
                # Update last login
                self.update_last_login(user[0])
                return {
                    'id': user[0],
                    'username': user[1], 
                    'role': user[3]
                }
        
        conn.close()
        print(f"🔍 AUTH: Authentication failed for username='{username}'")
        return None
    
    def update_last_login(self, user_id):
        """Cập nhật thời gian login cuối"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute('''
            UPDATE users 
            SET last_login = CURRENT_TIMESTAMP 
            WHERE id = ?
        ''', (user_id,))
        
        conn.commit()
        conn.close()
    
    def create_session(self, user_id):
        """Tạo session token cho user"""
        session_id = secrets.token_urlsafe(32)
        token = secrets.token_urlsafe(64)
        
        # Session expires in 24 hours
        from datetime import datetime, timedelta
        expires_at = datetime.now() + timedelta(hours=24)
        
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute('''
            INSERT INTO sessions (id, user_id, token, expires_at)
            VALUES (?, ?, ?, ?)
        ''', (session_id, user_id, token, expires_at))
        
        conn.commit()
        conn.close()
        
        return token
    
    def get_user_by_token(self, token):
        """Lấy thông tin user từ session token"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT u.id, u.username, u.role, s.expires_at
            FROM users u
            JOIN sessions s ON u.id = s.user_id
            WHERE s.token = ? AND s.expires_at > CURRENT_TIMESTAMP
        ''', (token,))
        
        result = cursor.fetchone()
        conn.close()
        
        if result:
            return {
                'id': result[0],
                'username': result[1],
                'role': result[2],
                'expires_at': result[3]
            }
        return None
    
    def invalidate_session(self, token):
        """Xóa session (logout)"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute('DELETE FROM sessions WHERE token = ?', (token,))
        
        conn.commit()
        conn.close()
    
    def cleanup_expired_sessions(self):
        """Dọn dẹp các session hết hạn"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute('DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP')
        
        conn.commit()
        conn.close()
    
    def get_all_users(self):
        """Lấy danh sách tất cả users (cho admin)"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT id, username, role, created_at, last_login
            FROM users
            ORDER BY id ASC
        ''')
        
        results = cursor.fetchall()
        conn.close()
        
        users = []
        for row in results:
            users.append({
                'id': row[0],
                'username': row[1], 
                'role': row[2],
                'created_at': row[3],
                'last_login': row[4]
            })
        
        return users
    
    def delete_user(self, user_id):
        """Xóa user (cho admin)"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        # Xóa sessions của user trước
        cursor.execute('DELETE FROM sessions WHERE user_id = ?', (user_id,))
        
        # Xóa user
        cursor.execute('DELETE FROM users WHERE id = ?', (user_id,))
        
        success = cursor.rowcount > 0
        conn.commit()
        conn.close()
        
        return success
    
    def reset_password(self, user_id, new_password):
        """Reset password của user (cho admin)"""
        password_hash = self.hash_password(new_password)
        
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute('''
            UPDATE users 
            SET password_hash = ?
            WHERE id = ?
        ''', (password_hash, user_id))
        
        success = cursor.rowcount > 0
        
        # Xóa tất cả sessions của user để force re-login
        cursor.execute('DELETE FROM sessions WHERE user_id = ?', (user_id,))
        
        conn.commit()
        conn.close()
        
        return success

# Test function để tạo admin user
def create_admin_user():
    """Tạo admin user mặc định"""
    auth_db = AuthDatabase()
    
    # Tạo admin user
    admin_id = auth_db.create_user("admin", "admin123", "admin")
    if admin_id:
        print(f"Admin user created with ID: {admin_id}")
    else:
        print("Admin user already exists")
    
    # Tạo test user
    user_id = auth_db.create_user("testuser", "test123", "user")  
    if user_id:
        print(f"Test user created with ID: {user_id}")
    else:
        print("Test user already exists")

if __name__ == "__main__":
    create_admin_user()
