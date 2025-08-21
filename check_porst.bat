@echo off
echo FlexTransfer Hub - Port Status Checker
echo ========================================

echo.
echo Checking ports...
echo.

echo Port 5000 (File Manager):
netstat -an | findstr ":5000 " > nul
if %errorlevel% == 0 (
    echo [RUNNING] File Manager is running on port 5000
) else (
    echo [NOT RUNNING] File Manager is not running
)

echo.
echo Port 8765 (WebSocket Server):
netstat -an | findstr ":8765 " > nul
if %errorlevel% == 0 (
    echo [RUNNING] WebSocket Server is running on port 8765
) else (
    echo [NOT RUNNING] WebSocket Server is not running
)

echo.
echo Port 8000 (Frontend):
netstat -an | findstr ":8000 " > nul
if %errorlevel% == 0 (
    echo [RUNNING] Frontend is running on port 8000
) else (
    echo [NOT RUNNING] Frontend is not running
)

echo.
echo ========================================
echo Services should run in this order:
echo 1. File Manager (port 5000)
echo 2. WebSocket Server (port 8765) 
echo 3. Frontend (port 8000)
echo.
echo Use start_all.bat to start all services
echo.
pause
