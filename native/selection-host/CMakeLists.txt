cmake_minimum_required(VERSION 3.24)

project(desktop_translate_selection_host VERSION 0.1.0 LANGUAGES CXX)

option(DT_NATIVE_BUILD_TESTS "Build native core tests" ON)
option(DT_NATIVE_ENABLE_PADDLE_OCR "Enable a linked PaddleOCR runtime adapter" OFF)

add_library(dt_native_core STATIC
  src/core/envelope.cpp
  src/core/frame_codec.cpp
  src/core/host_state_machine.cpp
  src/core/security.cpp
  src/core/utf8.cpp
)
target_include_directories(dt_native_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(dt_native_core PUBLIC cxx_std_20)

if(MSVC)
  target_compile_options(dt_native_core PRIVATE /W4 /permissive- /EHsc /utf-8)
else()
  target_compile_options(dt_native_core PRIVATE -Wall -Wextra -Wpedantic)
endif()

if(WIN32)
  if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
    message(FATAL_ERROR "selection-host supports Windows x64 only")
  endif()

  add_library(dt_selection_host_windows STATIC
    src/app/parent_process_monitor.cpp
    src/app/selection_host_app.cpp
    src/capture/desktop_duplication_capture.cpp
    src/coordinates/coordinates.cpp
    src/input_hook/mouse_hook.cpp
    src/ipc/named_pipe_server.cpp
    src/ocr/paddle_ocr_adapter.cpp
    src/selection/selection_pipeline.cpp
    src/uia/uia_worker.cpp
  )
  target_include_directories(dt_selection_host_windows PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
  target_compile_features(dt_selection_host_windows PUBLIC cxx_std_20)
  target_compile_definitions(dt_selection_host_windows PRIVATE
    NOMINMAX
    WIN32_LEAN_AND_MEAN
    UNICODE
    _UNICODE
    WINVER=0x0A00
    _WIN32_WINNT=0x0A00
    DT_NATIVE_ENABLE_PADDLE_OCR=$<BOOL:${DT_NATIVE_ENABLE_PADDLE_OCR}>
  )
  target_link_libraries(dt_selection_host_windows
    PUBLIC dt_native_core
    PRIVATE advapi32 d3d11 dxgi ole32 oleaut32 shcore user32
  )
  if(MSVC)
    target_compile_options(dt_selection_host_windows PRIVATE /W4 /permissive- /EHsc /utf-8)
  endif()

  add_executable(selection-host src/app/main.cpp resources/selection-host.rc)
  target_link_libraries(selection-host PRIVATE dt_selection_host_windows)
  target_include_directories(selection-host PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/resources)
  target_compile_definitions(selection-host PRIVATE
    NOMINMAX WIN32_LEAN_AND_MEAN UNICODE _UNICODE WINVER=0x0A00 _WIN32_WINNT=0x0A00)
  set_target_properties(selection-host PROPERTIES OUTPUT_NAME "selection-host")
  if(MINGW)
    # Produce a self-contained helper executable. Electron must be able to
    # launch the packaged host without inheriting an llvm-mingw toolchain PATH.
    target_link_options(selection-host PRIVATE -municode -static)
  endif()

  add_executable(selection-host-probe src/probes/main.cpp resources/selection-host.rc)
  target_link_libraries(selection-host-probe PRIVATE dt_selection_host_windows)
  target_include_directories(selection-host-probe PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/resources)
  target_compile_definitions(selection-host-probe PRIVATE
    NOMINMAX WIN32_LEAN_AND_MEAN UNICODE _UNICODE WINVER=0x0A00 _WIN32_WINNT=0x0A00)
  set_target_properties(selection-host-probe PROPERTIES OUTPUT_NAME "selection-host-probe")
  if(MINGW)
    target_link_options(selection-host-probe PRIVATE -municode -static)
  endif()
else()
  message(STATUS "selection-host and its Windows probes are disabled on non-Windows hosts")
endif()

if(DT_NATIVE_BUILD_TESTS)
  if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
    include(CTest)
  endif()
  enable_testing()
  add_executable(dt_native_core_tests tests/core_tests.cpp)
  target_link_libraries(dt_native_core_tests PRIVATE dt_native_core)
  target_compile_features(dt_native_core_tests PRIVATE cxx_std_20)
  if(MSVC)
    target_compile_options(dt_native_core_tests PRIVATE /W4 /permissive- /EHsc /utf-8)
  else()
    target_compile_options(dt_native_core_tests PRIVATE -Wall -Wextra -Wpedantic)
    if(MINGW)
      target_link_options(dt_native_core_tests PRIVATE -static)
    endif()
  endif()
  add_test(NAME dt_native_core_tests COMMAND dt_native_core_tests)
endif()
