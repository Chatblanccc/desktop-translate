#include "desktop_translate/native/input_hook/mouse_hook.h"

#include <utility>

namespace desktop_translate::native {

std::atomic<MouseHook*> MouseHook::active_instance_{nullptr};

MouseHook::MouseHook() : queue_event_(CreateEventW(nullptr, FALSE, FALSE, nullptr)) {}

MouseHook::~MouseHook() {
  Stop();
  if (queue_event_ != nullptr) CloseHandle(queue_event_);
}

bool MouseHook::Start() {
  if (queue_event_ == nullptr) return false;
  bool expected = false;
  if (!running_.compare_exchange_strong(expected, true)) return true;

  std::promise<bool> started;
  auto ready = started.get_future();
  thread_ = std::thread(&MouseHook::ThreadMain, this, std::move(started));
  if (!ready.get()) {
    running_.store(false, std::memory_order_release);
    if (thread_.joinable()) thread_.join();
    return false;
  }
  return true;
}

void MouseHook::Stop() noexcept {
  if (!running_.exchange(false, std::memory_order_acq_rel)) return;
  const auto id = thread_id_.load(std::memory_order_acquire);
  if (id != 0U) PostThreadMessageW(id, WM_QUIT, 0, 0);
  WakeConsumer();
  if (thread_.joinable()) thread_.join();
  thread_id_.store(0, std::memory_order_release);
}

bool MouseHook::WaitAndPop(MouseEvent& event, std::uint32_t timeout_ms) noexcept {
  if (queue_.TryPop(event)) return true;
  if (queue_event_ == nullptr) return false;
  if (WaitForSingleObject(queue_event_, timeout_ms) != WAIT_OBJECT_0) return false;
  return queue_.TryPop(event);
}

void MouseHook::WakeConsumer() noexcept {
  if (queue_event_ != nullptr) SetEvent(queue_event_);
}

void MouseHook::DiscardPendingEvents() noexcept {
  MouseEvent ignored;
  while (queue_.TryPop(ignored)) {}
  if (queue_event_ != nullptr) ResetEvent(queue_event_);
}

LRESULT CALLBACK MouseHook::HookProcedure(int code, WPARAM message, LPARAM data) noexcept {
  if (code == HC_ACTION) {
    if (auto* instance = active_instance_.load(std::memory_order_acquire); instance != nullptr) {
      instance->OnHookEvent(message, *reinterpret_cast<const MSLLHOOKSTRUCT*>(data));
    }
  }
  return CallNextHookEx(nullptr, code, message, data);
}

void MouseHook::ThreadMain(std::promise<bool> started) noexcept {
  thread_id_.store(GetCurrentThreadId(), std::memory_order_release);

  // Force creation of the thread message queue before Start returns.
  MSG message{};
  PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);

  MouseHook* expected = nullptr;
  if (!active_instance_.compare_exchange_strong(expected, this)) {
    started.set_value(false);
    return;
  }

  const auto hook = SetWindowsHookExW(WH_MOUSE_LL, HookProcedure, GetModuleHandleW(nullptr), 0);
  if (hook == nullptr) {
    active_instance_.store(nullptr, std::memory_order_release);
    started.set_value(false);
    return;
  }
  started.set_value(true);

  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }

  UnhookWindowsHookEx(hook);
  active_instance_.store(nullptr, std::memory_order_release);
}

void MouseHook::OnHookEvent(WPARAM message, const MSLLHOOKSTRUCT& data) noexcept {
  // Synthetic input is outside the product gesture contract. Reject it before
  // advancing the generation counter so automation cannot cancel a real
  // in-flight selection or perturb double-click state.
  if ((data.flags & LLMHF_INJECTED) != 0U) return;

  MouseEvent event;
  switch (message) {
    case WM_LBUTTONDOWN: event.kind = MouseEventKind::kLeftDown; break;
    // Mouse moves are intentionally coalesced out of the critical queue. The
    // consumer computes drag distance from down/up endpoints, preventing move
    // floods from evicting a release event while UIA/OCR is busy.
    case WM_MOUSEMOVE: return;
    case WM_LBUTTONUP: event.kind = MouseEventKind::kLeftUp; break;
    default: return;
  }

  event.point = {data.pt.x, data.pt.y};
  event.tick_ms = GetTickCount64();
  event.injected = false;
  event.alt_down = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
  if (event.kind == MouseEventKind::kLeftDown) {
    event.generation = latest_generation_.fetch_add(1U, std::memory_order_acq_rel) + 1U;
  } else {
    event.generation = latest_generation_.load(std::memory_order_acquire);
  }

  // No UIA, capture, IPC, allocation, waiting, or logging is permitted here.
  if (!queue_.TryPush(event)) {
    dropped_event_count_.fetch_add(1U, std::memory_order_relaxed);
    return;
  }
  SetEvent(queue_event_);
}

}  // namespace desktop_translate::native
