cmake_minimum_required(VERSION 3.24)

if(POLICY CMP0091)
  cmake_policy(SET CMP0091 NEW)
endif()

include(${CMAKE_CURRENT_SOURCE_DIR}/product-version.cmake)
project(desktop_translate_native_workspace VERSION ${DT_CMAKE_VERSION} LANGUAGES CXX)

# Phase 5 ships a self-contained Native Host.  Freeze the MSVC runtime before
# any targets are created so Release uses /MT (and Debug uses /MTd) instead of
# depending on a machine-wide VC Runtime installation.
if(MSVC)
  set(CMAKE_MSVC_RUNTIME_LIBRARY
      "MultiThreaded$<$<CONFIG:Debug>:Debug>"
      CACHE STRING "Desktop Translate MSVC runtime linkage" FORCE)
endif()

include(CTest)
add_subdirectory(selection-host)
