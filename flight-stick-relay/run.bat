@echo off
rem  flight_stick_relay launcher
rem  Builds if needed, then runs the relay + control panel.
cd /d "%~dp0"
if not exist build\flight_stick_relay.exe (
  echo [run] building...
  cmake -S . -B build -G "MinGW Makefiles" && cmake --build build -j
)
if not exist build\flight_stick_relay.exe (
  echo [run] build failed.
  exit /b 1
)
echo [run] starting flight_stick_relay
echo        open game\index.html in a browser, or http://localhost:8765/
start "" build\flight_stick_relay.exe
