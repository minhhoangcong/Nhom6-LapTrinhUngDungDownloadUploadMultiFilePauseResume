import sqlite3

def check_folder_files():
    conn = sqlite3.connect('files.db')
    cursor = conn.cursor()
    
    print("=== FILES WITH FOLDER IDs ===")
    cursor.execute("""
        SELECT id, filename, folder_id, status, user_id 
        FROM files 
        WHERE folder_id IS NOT NULL
        ORDER BY folder_id
    """)
    
    files_with_folders = cursor.fetchall()
    for file_data in files_with_folders:
        print(f"ID: {file_data[0]}, File: {file_data[1]}, Folder: {file_data[2]}, Status: {file_data[3]}, User: {file_data[4]}")
    
    print(f"\nTotal files with folders: {len(files_with_folders)}")
    
    # Check unique folder IDs
    cursor.execute("SELECT DISTINCT folder_id FROM files WHERE folder_id IS NOT NULL")
    unique_folders = cursor.fetchall()
    print(f"\nUnique folder IDs: {len(unique_folders)}")
    for folder in unique_folders:
        print(f"Folder ID: {folder[0]}")
        
        # Count files in each folder
        cursor.execute("SELECT COUNT(*) FROM files WHERE folder_id = ?", (folder[0],))
        count = cursor.fetchone()[0]
        print(f"  Files in this folder: {count}")
        
        # Show files in this folder
        cursor.execute("SELECT id, filename, status FROM files WHERE folder_id = ?", (folder[0],))
        folder_files = cursor.fetchall()
        for f in folder_files:
            print(f"    - ID: {f[0]}, File: {f[1]}, Status: {f[2]}")
        print()
    
    conn.close()

if __name__ == "__main__":
    check_folder_files()
