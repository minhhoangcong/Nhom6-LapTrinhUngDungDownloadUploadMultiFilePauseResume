@echo off
echo Starting FlexTransfer Hub Services...
echo.

echo Starting File Manager Server (Port 5000)...
start "File Manager" cmd /c "cd backend && python file_manager.py"
timeout /t 3 /nobreak > nul

echo Starting WebSocket Server (Port 8765)...
start "WebSocket Server" cmd /c "cd backend && python server.py"
timeout /t 3 /nobreak > nul

echo Starting Frontend Server (Port 8000)...
start "Frontend" cmd /c "cd frontend && python -m http.server 8000"
timeout /t 2 /nobreak > nul

echo.
echo All services started!
echo.
echo Access points:
echo - Upload Interface: http://localhost:8000
echo - File Manager: http://localhost:5000
echo.
echo Press any key to exit...
pause > nul
