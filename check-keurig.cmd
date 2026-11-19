@echo off
setlocal
set "PYTHON=%~dp0.venv\Scripts\python.exe"
if not exist "%PYTHON%" (
    echo Follow the Windows setup steps in README.md to create the Python environment.
    exit /b 1
)
"%PYTHON%" "%~dp0check_keurig.py" %*
exit /b %errorlevel%
