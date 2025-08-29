import database
import sqlite3

# Kết nối database để lấy file IDs
conn = sqlite3.connect('files.db')

# Lấy ID của file IMG_6159.JPG mới nhất
cursor = conn.execute('SELECT id FROM files WHERE filename = "IMG_6159.JPG" ORDER BY id DESC LIMIT 1')
result1 = cursor.fetchone()
file1_id = result1[0] if result1 else None

# Lấy ID của file IMG_7340.JPG mới nhất  
cursor = conn.execute('SELECT id FROM files WHERE filename = "IMG_7340.JPG" ORDER BY id DESC LIMIT 1')
result2 = cursor.fetchone()
file2_id = result2[0] if result2 else None

conn.close()

print(f'File IDs found: IMG_6159.JPG={file1_id}, IMG_7340.JPG={file2_id}')

# Cập nhật status bằng FileDatabase
db = database.FileDatabase()

if file1_id:
    db.update_file_status(file1_id, 'completed')
    print(f'✅ Updated IMG_6159.JPG (ID={file1_id}) to completed')

if file2_id:
    db.update_file_status(file2_id, 'completed')
    print(f'✅ Updated IMG_7340.JPG (ID={file2_id}) to completed')

print('All status updates completed!')
