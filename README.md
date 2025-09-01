# Dự án cuối kỳ môn Lập trình mạng - Nhóm 6

**Trường:** Đại học Giao thông Vận tải TP Hồ Chí Minh
**Thành viên nhóm:**

- Hoàng Công Minh
- Nguyễn Đức Minh
- Châu Hồng Vũ
- Nguyễn Tiến Vươn
  **Giảng viên hướng dẫn:** Bùi Dương Thế
  **Thời gian thực hiện:** 17/7 đến 5/9

# FlexTransfer Hub - Hệ thống Upload và Quản lý Files với Phân Quyền

Ứng dụng quản lý chuyển file chuyên nghiệp với khả năng upload files lên remote server và quản lý files thông qua giao diện web riêng biệt. **Tích hợp hệ thống phân quyền người dùng đầy đủ.**

## 🚀 Tính năng mới

- **🔐 Hệ thống phân quyền**: Đăng nhập/đăng ký, quản lý user và session
- **👤 User isolation**: Mỗi user chỉ thấy files của mình
- **🗑️ Recycle Bin**: Thùng rác với khả năng khôi phục files trong 7-30 ngày
- **👁️ File Preview**: Preview ảnh, PDF, video, audio và text files
- **Upload files lên remote server**: Files được gửi đến một web server khác thay vì lưu local
- **Trang quản lý files riêng biệt**: Giao diện web chuyên dụng để quản lý files và folders
- **Quản lý folders**: Tạo, xóa, tổ chức folders với nested support
- **Thống kê real-time**: Hiển thị số lượng files, folders, dung lượng tổng theo user
- **Tìm kiếm và lọc**: Tìm kiếm files theo tên, lọc theo loại
- **Download files**: Download files từ remote server

## 🏗️ Kiến trúc hệ thống

```
┌─────────────────┐    WebSocket    ┌─────────────────┐    HTTP POST    ┌─────────────────┐
│   Frontend      │ ──────────────► │  WebSocket      │ ──────────────► │  File Manager   │
│   (Upload UI)   │                 │  Server         │                 │  Server         │
└─────────────────┘                 └─────────────────┘                 └─────────────────┘
                                              │                                │
                                              │                      ┌─────────┴─────────┐
                                              ▼                      │                   │
                                    ┌─────────────────┐              ▼                   ▼
                                    │  Temp Storage   │    ┌─────────────────┐  ┌─────────────────┐
                                    │  (Local)        │    │  Auth Database  │  │  File Database  │
                                    └─────────────────┘    │  (SQLite)       │  │  (SQLite)       │
                                                           └─────────────────┘  └─────────────────┘
```

## 🔐 Database Schema

### Bảng users

```sql
users(
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE,
  password_hash TEXT,
  role TEXT,
  created_at TIMESTAMP,
  last_login TIMESTAMP
)
```

### Bảng files

```sql
files(
  id INTEGER PRIMARY KEY,
  filename TEXT,
  original_filename TEXT,
  size INTEGER,
  user_id INTEGER,
  folder_id TEXT,
  file_path TEXT,
  created_at TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
)
```

### Bảng folders

```sql
folders(
  id TEXT PRIMARY KEY,
  name TEXT,
  path TEXT,
  parent_id TEXT,
  user_id INTEGER,
  created_at TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
)
```

### Bảng recycle_bin

```sql
recycle_bin(
  id INTEGER PRIMARY KEY,
  original_file_id INTEGER,
  filename TEXT,
  original_filename TEXT,
  size INTEGER,
  user_id INTEGER,
  file_path TEXT,
  deleted_by INTEGER,
  deleted_at TIMESTAMP,
  restore_deadline TIMESTAMP,
  status TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (deleted_by) REFERENCES users(id)
)
```

### Bảng sessions

```sql
sessions(
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  token TEXT UNIQUE,
  expires_at TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
)
```

## 📁 Cấu trúc thư mục

```
backend/
├── server.py              # WebSocket server (nhận files)
├── file_manager.py        # Flask server (quản lý files + authentication)
├── auth_database.py       # Authentication database helper
├── database.py            # File database helper
├── migrate_database.py    # Database migration script
├── templates/
│   ├── index.html         # Giao diện quản lý files (cần đăng nhập)
│   ├── login.html         # Trang đăng nhập
│   └── register.html      # Trang đăng ký
├── temp_uploads/          # Thư mục tạm lưu files
```

backend/remote_uploads/ # Thư mục lưu files cuối cùng
│ └── {username}/ # Folders riêng cho từng user (theo username)
├── auth.db # Database lưu users và sessions
├── files.db # Database lưu metadata files
└── requirements.txt # Dependencies

frontend/
├── index.html # Giao diện upload files
├── script.js # Logic upload
└── style.css # Styles

````

## 🛠️ Cài đặt và chạy

### 1. Cài đặt dependencies

```bash
cd backend
pip install -r requirements.txt
````

### 2. Khởi tạo database và tạo admin user

```bash
cd backend
python auth_database.py
python migrate_database.py
```

**Default accounts được tạo:**

- **admin** / **admin123** (role: admin)
- **testuser** / **test123** (role: user)

### 3. Chạy File Manager Server (với authentication)

```bash
cd backend
python file_manager.py
```

Server sẽ chạy trên `http://localhost:5000`

### 4. Chạy WebSocket Server (nhận files)

```bash
cd backend
python server.py
```

Server sẽ chạy trên `ws://localhost:8765`

### 5. Chạy Frontend (giao diện upload)

```bash
cd frontend
python -m http.server 8000
```

Truy cập `http://localhost:8000` để upload files

### Lưu ý khi khởi động dự án mới

Nếu bạn vừa copy code sang thư mục mới và chưa có file `auth.db` hoặc chưa có tài khoản admin, hãy chạy script sau để tạo tài khoản admin mặc định:

```bash
cd backend
python create_admin.py
```

Sau khi chạy xong, bạn có thể đăng nhập vào admin panel bằng tài khoản:

- **admin** / **admin123**

Không cần copy file database cũ, chỉ cần chạy script này là có thể sử dụng quyền admin để quản lý hệ thống.

## 🔧 Cấu hình

### Environment Variables

Tạo file `.env` trong thư mục `backend`:

```env
REMOTE_UPLOAD_URL=http://localhost:5000/api/upload
REMOTE_SERVER_TOKEN=your-secret-token
WS_HOST=localhost
WS_PORT=8765
```

### Thay đổi cấu hình

- **REMOTE_UPLOAD_URL**: URL của server quản lý files
- **REMOTE_SERVER_TOKEN**: Token xác thực (có thể bỏ qua nếu chạy local)
- **WS_HOST/WS_PORT**: Host và port của WebSocket server

## 📱 Sử dụng

### 1. Đăng nhập vào hệ thống

1. Mở `http://localhost:5000`
2. Đăng nhập bằng tài khoản:
   - **admin** / **admin123** (quản trị viên)
   - **testuser** / **test123** (người dùng)
   - Hoặc đăng ký tài khoản mới

### 2. Upload Files

1. Sau khi đăng nhập, click "Upload Files" để mở `http://localhost:8000`
2. Kéo thả files hoặc click "browse files"
3. Files sẽ được upload qua WebSocket và gửi đến File Manager Server
4. **Files sẽ được lưu với username của bạn và chỉ bạn mới thấy được**

### 3. Quản lý Files

1. Quay lại `http://localhost:5000` (file manager)
2. Xem danh sách files **chỉ thuộc về tài khoản của bạn**
3. Tạo folders mới (nested folders support)
4. Download hoặc xóa files
5. Tìm kiếm files theo tên
6. Move files giữa các folders

### 4. Thống kê User

- Tổng số files và folders **của user hiện tại**
- Dung lượng tổng **của user hiện tại**
- Số loại files khác nhau **của user hiện tại**

### 6. Thùng rác (Recycle Bin)

- Click nút "🗑️ Thùng rác" để xem files đã xóa
- **Xóa file**: Files bị "xóa" sẽ chuyển vào thùng rác, không bị xóa vĩnh viễn
- **Thời gian lưu giữ**:
  - User files: 7 ngày
  - Admin files: 30 ngày
- **Khôi phục**: Click "♻️ Khôi phục" để đưa file về trạng thái bình thường
- **Xóa vĩnh viễn**: Click "💀 Xóa vĩnh viễn" để xóa hoàn toàn (không thể khôi phục)

### 7. Preview Files

- Click nút "👁️ Preview" bên cạnh file để xem trước
- **Hỗ trợ**: Ảnh, PDF, Video, Audio, Text files
- **Fallback**: Files không hỗ trợ sẽ hiện nút download

### 8. Đăng xuất

- Click "Đăng xuất" ở góc phải màn hình
- Session sẽ được xóa và redirect về trang login

## 🔒 Bảo mật

- **🔐 Session-based Authentication**: Sử dụng secure session tokens với expiration
- **🔑 Password Hashing**: PBKDF2 với salt cho bảo mật cao
- **👤 User Isolation**: Mỗi user chỉ thấy và truy cập files của mình
- **🗂️ File Segregation**: Files được lưu trong folders riêng biệt theo username
- **⏰ Session Management**: Auto logout khi token hết hạn
- **🛡️ Authorization Middleware**: Kiểm tra quyền truy cập cho mọi API call
- **📁 Secure Filenames**: Sử dụng `secure_filename` để tránh path traversal
- **🔍 Input Validation**: Kiểm tra tên file và kích thước

## 🚨 Troubleshooting

### Lỗi thường gặp

1. **Không thể đăng nhập**

   - Kiểm tra username/password
   - Kiểm tra database auth.db có tồn tại không
   - Chạy `python auth_database.py` để tạo lại admin user

2. **Database errors**

   - Chạy `python migrate_database.py` để cập nhật schema
   - Xóa files.db và auth.db để reset database

3. **Files không hiển thị**

   - Kiểm tra đã đăng nhập chưa
   - Files chỉ hiển thị cho đúng user đã upload

4. **Upload không work**
   - Kiểm tra WebSocket server có chạy không
   - Kiểm tra authentication token
   - Kiểm tra user có quyền upload không

### Logs

- WebSocket server: Logs hiển thị trong terminal
- File Manager: Logs hiển thị trong terminal (Flask debug mode)

## 🔄 Workflow

1. **Upload**: User upload file qua frontend
2. **WebSocket**: File được gửi qua WebSocket đến server
3. **Temp Storage**: File được lưu tạm thời
4. **Remote Upload**: File được gửi đến File Manager Server
5. **Storage**: File được lưu vào thư mục cuối cùng
6. **Database**: Thông tin file được lưu vào database
7. **Management**: User có thể quản lý file qua giao diện web

## 📈 Mở rộng

### Thêm tính năng

- **User Authentication**: Đăng nhập/đăng ký
- **File Sharing**: Chia sẻ files với người khác
- **Version Control**: Quản lý phiên bản files
- **Cloud Storage**: Tích hợp với AWS S3, Google Drive
- **API Rate Limiting**: Giới hạn số lượng upload
- **File Compression**: Nén files trước khi upload

### Tối ưu hóa

- **CDN**: Sử dụng CDN để phân phối files
- **Caching**: Cache metadata và thumbnails
- **Load Balancing**: Cân bằng tải giữa nhiều server
- **Database**: Sử dụng PostgreSQL/MySQL thay vì JSON file

## 📄 License

MIT License - Tự do sử dụng và chỉnh sửa.

## 🤝 Contributing

1. Fork repository
2. Tạo feature branch
3. Commit changes
4. Push to branch
5. Tạo Pull Request

## 📞 Support

Nếu gặp vấn đề, vui lòng tạo issue trên GitHub hoặc liên hệ team phát triển.
