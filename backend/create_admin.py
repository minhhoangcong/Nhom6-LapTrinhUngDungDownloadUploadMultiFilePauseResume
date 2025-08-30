#!/usr/bin/env python3
"""
Script to create admin user for the file manager system
"""

from auth_database import AuthDatabase

def create_admin_user():
    """Create an admin user"""
    db = AuthDatabase()
    
    # Check if admin user already exists
    try:
        import sqlite3
        conn = sqlite3.connect('auth.db')
        cursor = conn.cursor()
        
        cursor.execute("SELECT * FROM users WHERE role = 'admin'")
        admin_users = cursor.fetchall()
        
        if admin_users:
            print("Admin user already exists:")
            for user in admin_users:
                print(f"  Username: {user[1]}, Role: {user[3]}")
        else:
            # Create admin user
            admin_username = "admin"
            admin_password = "admin123"
            
            success = db.create_user(admin_username, admin_password, role='admin')
            if success:
                print(f"✅ Admin user created successfully!")
                print(f"  Username: {admin_username}")
                print(f"  Password: {admin_password}")
                print(f"  Role: admin")
            else:
                print("❌ Failed to create admin user")
        
        # Show all users
        cursor.execute("SELECT * FROM users")
        all_users = cursor.fetchall()
        print(f"\nAll users in database ({len(all_users)}):")
        for user in all_users:
            print(f"  ID: {user[0]}, Username: {user[1]}, Role: {user[3]}")
            
        conn.close()
        
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    create_admin_user()
