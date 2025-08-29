import sqlite3

conn = sqlite3.connect('files.db')
cursor = conn.execute('SELECT id, filename, file_path, folder_id FROM files WHERE user_id = 1 LIMIT 10')
print('Sample file paths:')
for row in cursor.fetchall():
    print(f'ID: {row[0]}, Name: {row[1]}, Path: {row[2]}, FolderID: {row[3]}')

# Count files by path structure
cursor = conn.execute('''
SELECT 
  CASE 
    WHEN file_path IS NULL THEN 'NULL path'
    WHEN file_path = '' THEN 'Empty path'
    ELSE 'Has path: ' || file_path
  END as path_type,
  COUNT(*) as count
FROM files 
WHERE user_id = 1 
GROUP BY path_type
''')
print('\nFile path distribution:')
for row in cursor.fetchall():
    print(f'{row[0]}: {row[1]} files')

conn.close()
