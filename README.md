# FlexTransfer Hub - Hệ thống Upload và Quản lý Files

Ứng dụng quản lý chuyển file chuyên nghiệp với khả năng upload files lên remote server và quản lý files thông qua giao diện web riêng biệt.

## 🚀 Tính năng mới

- **Upload files lên remote server**: Files được gửi đến một web server khác thay vì lưu local
- **Trang quản lý files riêng biệt**: Giao diện web chuyên dụng để quản lý files và folders
- **Quản lý folders**: Tạo, xóa, tổ chức folders
- **Thống kê real-time**: Hiển thị số lượng files, folders, dung lượng tổng
- **Tìm kiếm và lọc**: Tìm kiếm files theo tên, lọc theo loại
- **Download files**: Download files từ remote server

## 🏗️ Kiến trúc hệ thống

```
┌─────────────────┐    WebSocket    ┌─────────────────┐    HTTP POST    ┌─────────────────┐
│   Frontend      │ ──────────────► │  WebSocket      │ ──────────────► │  File Manager   │
│   (Upload UI)   │                 │  Server         │                 │  Server         │
└─────────────────┘                 └─────────────────┘                 └─────────────────┘
                                              │                                │
                                              │                                │
                                              ▼                                ▼
                                    ┌─────────────────┐                ┌─────────────────┐
                                    │  Temp Storage   │                │  Remote Files   │
                                    │  (Local)        │                │  (Database)      │
                                    └─────────────────┘                └─────────────────┘
```

## 📁 Cấu trúc thư mục

```
backend/
├── server.py              # WebSocket server (nhận files)
├── file_manager.py        # Flask server (quản lý files)
├── templates/
│   └── index.html         # Giao diện quản lý files
├── temp_uploads/          # Thư mục tạm lưu files
├── remote_uploads/        # Thư mục lưu files cuối cùng
└── requirements.txt       # Dependencies

frontend/
├── index.html             # Giao diện upload files
├── script.js              # Logic upload
└── style.css              # Styles
```

## 🛠️ Cài đặt và chạy

### 1. Cài đặt dependencies

```bash
cd backend
pip install -r requirements.txt
```

### 2. Chạy WebSocket Server (nhận files)

```bash
cd backend
python server.py
```

Server sẽ chạy trên `ws://localhost:8765`

### 3. Chạy File Manager Server (quản lý files)

```bash
cd backend
python file_manager.py
```

Server sẽ chạy trên `http://localhost:5000`

### 4. Chạy Frontend (giao diện upload)

```bash
cd frontend
python -m http.server 8000
```

Truy cập `http://localhost:8000` để upload files

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

### 1. Upload Files

1. Mở `http://localhost:8000` (frontend)
2. Kéo thả files hoặc click "browse files"
3. Files sẽ được upload qua WebSocket và gửi đến File Manager Server

### 2. Quản lý Files

1. Mở `http://localhost:5000` (file manager)
2. Xem danh sách files đã upload
3. Tạo folders mới
4. Download hoặc xóa files
5. Tìm kiếm files theo tên

### 3. Thống kê

- Tổng số files và folders
- Dung lượng tổng
- Số loại files khác nhau

## 🔒 Bảo mật

- **Token Authentication**: Sử dụng Bearer token để xác thực
- **File Validation**: Kiểm tra tên file và kích thước
- **Secure Filenames**: Sử dụng `secure_filename` để tránh path traversal

## 🚨 Troubleshooting

### Lỗi thường gặp

1. **Port đã được sử dụng**

   - Thay đổi port trong code hoặc dừng service đang chạy

2. **Files không upload được**

   - Kiểm tra WebSocket server có đang chạy không
   - Kiểm tra kết nối giữa WebSocket server và File Manager

3. **Files không hiển thị**
   - Kiểm tra File Manager server có đang chạy không
   - Kiểm tra database file có được tạo không

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
