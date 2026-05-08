@echo off
chcp 65001 >nul
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
  echo 未找到 Python，请先安装 Python 3.10+（64 位）并勾选 Add to PATH。
  pause
  exit /b 1
)

python -c "import SimConnect" 2>nul
if errorlevel 1 (
  echo 正在安装依赖 SimConnect …
  python -m pip install -r requirements.txt
  if errorlevel 1 (
    echo pip 安装失败。
    pause
    exit /b 1
  )
)

echo 启动桥接服务（关闭本窗口即停止）…
echo 提示：手机与电脑需同一 Wi-Fi，在浏览器输入窗口里「局域网访问」开头的地址。
echo 若手机打不开，检查 Windows 防火墙是否放行端口 8764。
python msfs_bridge.py
pause
