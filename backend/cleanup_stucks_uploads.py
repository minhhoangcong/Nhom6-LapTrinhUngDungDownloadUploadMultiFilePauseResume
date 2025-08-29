import sqlite3
from datetime import datetime, timedelta

def cleanup_stuck_uploads():
    """Clean up files stuck in uploading status"""
    
    conn = sqlite3.connect('files.db')
    cursor = conn.cursor()
    
    # Get files stuck in uploading status for more than 30 minutes
    cutoff_time = datetime.now() - timedelta(minutes=30)
    cutoff_iso = cutoff_time.isoformat()
    
    cursor.execute("""
        SELECT id, filename, created_at, user_id 
        FROM files 
        WHERE status = 'uploading' AND created_at < ?
    """, (cutoff_iso,))
    
    stuck_files = cursor.fetchall()
    
    print(f"Found {len(stuck_files)} files stuck in uploading status:")
    for file_id, filename, created_at, user_id in stuck_files:
        print(f"  ID: {file_id}, File: {filename}, Created: {created_at}, User: {user_id}")
    
    if len(stuck_files) == 0:
        print("✅ No stuck files found!")
        conn.close()
        return
    
    print("\nChoose action:")
    print("1. Mark stuck uploads as 'failed' (keep records)")
    print("2. Delete stuck uploads completely")
    print("3. Mark as 'completed' (if files exist on disk)")
    
    choice = input("Enter choice (1, 2, or 3): ").strip()
    
    if choice == "1":
        # Mark as failed
        cursor.execute("""
            UPDATE files 
            SET status = 'failed' 
            WHERE status = 'uploading' AND created_at < ?
        """, (cutoff_iso,))
        updated = cursor.rowcount
        conn.commit()
        print(f"✅ Marked {updated} files as 'failed'")
        
    elif choice == "2":
        # Delete completely
        cursor.execute("""
            DELETE FROM files 
            WHERE status = 'uploading' AND created_at < ?
        """, (cutoff_iso,))
        deleted = cursor.rowcount
        conn.commit()
        print(f"✅ Deleted {deleted} stuck upload records")
        
    elif choice == "3":
        # Mark as completed
        cursor.execute("""
            UPDATE files 
            SET status = 'completed' 
            WHERE status = 'uploading' AND created_at < ?
        """, (cutoff_iso,))
        updated = cursor.rowcount
        conn.commit()
        print(f"✅ Marked {updated} files as 'completed'")
        
    else:
        print("❌ Invalid choice!")
        conn.close()
        return
    
    # Verify cleanup
    cursor.execute("SELECT COUNT(*) FROM files WHERE status = 'uploading'")
    remaining = cursor.fetchone()[0]
    print(f"📊 Remaining files in 'uploading' status: {remaining}")
    
    conn.close()

if __name__ == "__main__":
    cleanup_stuck_uploads()
