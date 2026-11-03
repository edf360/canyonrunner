cmake_minimum_required(VERSION 3.16)
project(flight_stick_relay C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

if(NOT WIN32)
  message(FATAL_ERROR "This project targets Windows (joystick/winmm/dinput8).")
endif()

# --- Warnings / defines -----------------------------------------------------
add_compile_definitions(
  UNICODE
  _UNICODE
  WIN32_LEAN_AND_MEAN
  _WIN32_WINNT=0x0A00
)

if(MSVC)
  add_compile_options(/W3 /utf-8)
else()
  add_compile_options(-Wall -Wextra -Wno-unused-parameter)
endif()

# --- Third party: mongoose (single-file WS/TCP/HTTP) ------------------------
set(MONGOOSE_DIR ${CMAKE_SOURCE_DIR}/third_party/mongoose)
if(NOT EXISTS ${MONGOOSE_DIR}/mongoose.c)
  message(FATAL_ERROR "mongoose not found in third_party/mongoose (git clone required).")
endif()

# --- Third party: microui (immediate-mode GUI) ------------------------------
set(MICROUI_DIR ${CMAKE_SOURCE_DIR}/third_party/microui)
if(NOT EXISTS ${MICROUI_DIR}/src/microui.c)
  message(FATAL_ERROR "microui not found in third_party/microui (git clone required).")
endif()

# --- Sources ----------------------------------------------------------------
file(GLOB_RECURSE PROJECT_SOURCES CONFIGURE_DEPENDS
  ${CMAKE_SOURCE_DIR}/src/*.c
)

add_executable(flight_stick_relay
  ${PROJECT_SOURCES}
  ${MONGOOSE_DIR}/mongoose.c
  ${MICROUI_DIR}/src/microui.c
)

target_include_directories(flight_stick_relay PRIVATE
  ${CMAKE_SOURCE_DIR}/src
  ${MONGOOSE_DIR}
  ${MICROUI_DIR}/src
  ${MICROUI_DIR}/demo
)

# Disable mongoose built-in event log noise; we drive polling ourselves.
target_compile_definitions(flight_stick_relay PRIVATE
  MG_TLS=MG_TLS_NONE
  MG_ENABLE_LOG=0
)

# --- Windows import libraries -----------------------------------------------
# winmm    : joyGetPosEx / joyGetCaps
# dinput8  : DirectInput8Create (FFB)
# dxguid   : IID/DIID symbols
# ole32    : COM (CoCreateInstance)
# ws2_32   : sockets (mongoose)
# opengl32/gdi32/user32: microui GL3 host
# shell32  : taskbar tray (Shell_NotifyIcon)
# imm32    : IME (microui)
target_link_libraries(flight_stick_relay PRIVATE
  winmm
  dinput8
  dxguid
  ole32
  ws2_32
  opengl32
  gdi32
  user32
  shell32
  imm32
  gdi32
)

# MinGW: keep a console build switch off for release GUI later.
if(MINGW)
  target_link_options(flight_stick_relay PRIVATE -static)
endif()
