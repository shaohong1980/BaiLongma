@echo off
chcp 65001 >nul
cd /d "D:\hermes-agent\西李村信息发布系统"
echo ============================================
echo   西李村综合信息发布系统
echo   河南省科技特派员 - 张诗红
echo ============================================
echo.
echo 启动中... http://localhost:8080
echo 按 Ctrl+C 停止服务
echo.
call D:\hermes-agent\.venv\Scripts\activate.bat
python -m uvicorn server:app --host 0.0.0.0 --port 8080
pause
