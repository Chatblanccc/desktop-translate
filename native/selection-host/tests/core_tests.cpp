#include <array>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

#include "desktop_translate/native/core/bounded_spsc_queue.h"
#include "desktop_translate/native/core/envelope.h"
#include "desktop_translate/native/core/frame_codec.h"
#include "desktop_translate/native/core/host_state_machine.h"
#include "desktop_translate/native/core/security.h"
#include "desktop_translate/native/core/utf8.h"

namespace dt = desktop_translate::native;

namespace {

int failures = 0;

void Check(bool condition, const char* message) {
  if (!condition) {
    ++failures;
    std::cerr << "FAIL: " << message << '\n';
  }
}

void TestFrameCodecHandlesPartialAndCoalescedFrames() {
  const auto first = dt::EncodeFrame("{\"one\":1}");
  const auto second = dt::EncodeFrame("{\"two\":2}");
  std::vector<std::uint8_t> bytes(first);
  bytes.insert(bytes.end(), second.begin(), second.end());

  dt::FrameDecoder decoder;
  const auto partial = decoder.Feed(std::span<const std::uint8_t>(bytes.data(), 3U));
  Check(partial.error == dt::ErrorCode::kOk && partial.frames.empty(),
        "partial frame must be buffered");
  const auto remaining = decoder.Feed(
      std::span<const std::uint8_t>(bytes.data() + 3U, bytes.size() - 3U));
  Check(remaining.error == dt::ErrorCode::kOk, "coalesced frames must decode");
  Check(remaining.frames.size() == 2U, "two frames must be returned");
  Check(remaining.frames.size() >= 2U && remaining.frames[0] == "{\"one\":1}",
        "first payload must be unchanged");
  Check(remaining.frames.size() >= 2U && remaining.frames[1] == "{\"two\":2}",
        "second payload must be unchanged");
}

void TestFrameCodecRejectsInvalidLengths() {
  dt::FrameDecoder decoder(8U);
  const std::array<std::uint8_t, 4> too_large{9U, 0U, 0U, 0U};
  auto result = decoder.Feed(too_large);
  Check(result.error == dt::ErrorCode::kFrameTooLarge, "oversized frame must fail closed");

  decoder.Reset();
  const std::array<std::uint8_t, 4> empty{0U, 0U, 0U, 0U};
  result = decoder.Feed(empty);
  Check(result.error == dt::ErrorCode::kMalformedFrame, "zero-length frame must fail closed");
}

void TestEnvelopeRoundTripAndValidation() {
  dt::Envelope request;
  request.kind = dt::MessageKind::kRequest;
  request.id = "req-1";
  request.method = "hello";
  request.timestamp = "2026-07-16T12:00:00.000Z";
  request.payload_json = "{\"nonce\":\"a1b2\",\"client\":\"electron-main\"}";

  const auto encoded = dt::EncodeEnvelope(request);
  const auto decoded = dt::DecodeEnvelope(encoded);
  Check(decoded.error == dt::ErrorCode::kOk, "valid envelope must decode");
  Check(decoded.envelope.id && *decoded.envelope.id == "req-1", "request id must round-trip");
  Check(decoded.envelope.method == "hello", "method must round-trip");
  const auto nonce = dt::FindJsonStringField(decoded.envelope.payload_json, "nonce");
  Check(nonce && *nonce == "a1b2", "nonce must be read from payload");

  const auto wrong_version = dt::DecodeEnvelope(
      "{\"v\":2,\"kind\":\"request\",\"method\":\"hello\","
      "\"timestamp\":\"2026-07-16T12:00:00Z\",\"payload\":{}} ");
  Check(wrong_version.error == dt::ErrorCode::kUnsupportedProtocol,
        "unknown protocol versions must be rejected");

  const auto duplicate = dt::DecodeEnvelope(
      "{\"v\":1,\"v\":1,\"kind\":\"request\",\"method\":\"hello\","
      "\"timestamp\":\"2026-07-16T12:00:00Z\",\"payload\":{}}");
  Check(duplicate.error == dt::ErrorCode::kMalformedJson,
        "duplicate envelope keys must be rejected");

  const auto escaped = dt::DecodeEnvelope(
      "{\"v\":1,\"kind\":\"request\",\"id\":\"\\u0061\","
      "\"method\":\"health\",\"timestamp\":\"2026-07-16T12:00:00+08:00\","
      "\"payload\":{}}");
  Check(escaped.error == dt::ErrorCode::kOk && escaped.envelope.id &&
            *escaped.envelope.id == "a",
        "unicode escapes in envelope strings must decode");

  const auto missing_id = dt::DecodeEnvelope(
      "{\"v\":1,\"kind\":\"request\",\"method\":\"health\","
      "\"timestamp\":\"2026-07-16T12:00:00Z\",\"payload\":{}}");
  Check(missing_id.error == dt::ErrorCode::kMalformedJson,
        "request envelopes must contain an id");

  const auto malformed_nested = dt::DecodeEnvelope(
      "{\"v\":1,\"kind\":\"request\",\"id\":\"x\",\"method\":\"start\","
      "\"timestamp\":\"2026-07-16T12:00:00Z\",\"payload\":{\"items\":[1,]}}");
  Check(malformed_nested.error == dt::ErrorCode::kMalformedJson,
        "malformed nested JSON must be rejected");

  const auto invalid_timestamp = dt::DecodeEnvelope(
      "{\"v\":1,\"kind\":\"request\",\"id\":\"x\",\"method\":\"health\","
      "\"timestamp\":\"2026-02-30T12:00:00Z\",\"payload\":{}}");
  Check(invalid_timestamp.error == dt::ErrorCode::kMalformedJson,
        "invalid RFC3339 calendar dates must be rejected");

  const auto config = std::string(
      "{\"enableUia\":false,\"settleDelayMs\":80,\"minDragDistancePx\":4.5,"
      "\"supportedVersions\":[1],\"excludedProcessNames\":[\"secret.exe\"]}");
  Check(dt::FindJsonBoolField(config, "enableUia") == false,
        "boolean fields must decode");
  Check(dt::FindJsonUnsignedField(config, "settleDelayMs") == 80U,
        "unsigned fields must decode");
  Check(dt::FindJsonNumberField(config, "minDragDistancePx") == 4.5,
        "number fields must decode");
  const auto versions = dt::FindJsonUnsignedArrayField(config, "supportedVersions");
  Check(versions && versions->size() == 1U && (*versions)[0] == 1U,
        "unsigned arrays must decode");
  const auto exclusions = dt::FindJsonStringArrayField(config, "excludedProcessNames");
  Check(exclusions && exclusions->size() == 1U && (*exclusions)[0] == "secret.exe",
        "string arrays must decode");
}

void TestStateMachineIsIdempotentAndTerminal() {
  dt::HostStateMachine machine;
  auto transition = machine.Start();
  Check(transition.changed && machine.state() == dt::HostState::kRunning,
        "start must enter running");
  transition = machine.Start();
  Check(!transition.changed && transition.error == dt::ErrorCode::kOk,
        "start must be idempotent");
  transition = machine.Stop();
  Check(transition.changed && machine.state() == dt::HostState::kStopped,
        "stop must enter stopped");
  transition = machine.Shutdown();
  Check(transition.changed && machine.state() == dt::HostState::kShuttingDown,
        "shutdown must be terminal");
  transition = machine.Start();
  Check(!transition.changed && transition.error == dt::ErrorCode::kInvalidState,
        "start after shutdown must fail");
}

void TestBoundedQueueWrapAndFullState() {
  dt::BoundedSpscQueue<int, 4> queue;
  Check(queue.TryPush(1) && queue.TryPush(2) && queue.TryPush(3),
        "queue must accept capacity items");
  Check(!queue.TryPush(4), "queue must reject overflow without blocking");
  int value = 0;
  Check(queue.TryPop(value) && value == 1, "queue must preserve FIFO order");
  Check(queue.TryPush(4), "queue must reuse a wrapped slot");
  Check(queue.TryPop(value) && value == 2, "second item must be preserved");
  Check(queue.TryPop(value) && value == 3, "third item must be preserved");
  Check(queue.TryPop(value) && value == 4, "wrapped item must be preserved");
  Check(!queue.TryPop(value) && queue.empty(), "empty queue must not produce values");
}

void TestUtf16UnitLimitHandlesAstralText() {
  const std::string emoji = "\xf0\x9f\x98\x80";
  std::string exact;
  exact.reserve(16'384U * emoji.size());
  for (std::size_t index = 0; index < 16'384U; ++index) exact += emoji;
  Check(dt::Utf16CodeUnitLength(exact) == 32'768U,
        "16,384 astral characters must occupy 32,768 UTF-16 units");
  Check(dt::TruncateUtf8ToUtf16Units(exact + emoji, 32'768U) == exact,
        "astral text must truncate by UTF-16 units, not code points");

  const std::string boundary = std::string(32'767U, 'a') + emoji + "z";
  Check(dt::TruncateUtf8ToUtf16Units(boundary, 32'768U) == std::string(32'767U, 'a'),
        "a surrogate pair must not be split at the unit boundary");
  Check(dt::TruncateUtf8ToUtf16Units(std::string("a\0b", 3U), 3U) ==
            "a\xef\xbf\xbd" "b",
        "embedded NUL must be replaced before text crosses IPC");
}

void TestUtf8ValidationAndConstantTimeComparison() {
  Check(dt::IsValidUtf8("plain \xf0\x9f\x98\x80"), "valid astral UTF-8 must pass");
  Check(!dt::IsValidUtf8("\xc0\xaf"), "overlong UTF-8 must fail");
  Check(!dt::IsValidUtf8("\xed\xa0\x80"), "UTF-8 encoded surrogate must fail");
  Check(!dt::IsValidUtf8("\xf4\x90\x80\x80"), "code points above U+10FFFF must fail");
  std::string invalid_envelope =
      "{\"v\":1,\"kind\":\"request\",\"id\":\"x\",\"method\":\"health\","
      "\"timestamp\":\"2026-07-16T12:00:00Z\",\"payload\":{},\"bad\":\"";
  invalid_envelope += "\xc0\xaf\"}";
  Check(dt::DecodeEnvelope(invalid_envelope).error == dt::ErrorCode::kMalformedJson,
        "envelope decoding must fail closed on invalid UTF-8");
  Check(dt::ConstantTimeEquals("001122", "001122"), "equal nonces must compare equal");
  Check(!dt::ConstantTimeEquals("001122", "001123"), "different nonces must compare unequal");
  Check(!dt::ConstantTimeEquals("001122", "00112200"), "nonce lengths must match");
}

}  // namespace

int main() {
  TestFrameCodecHandlesPartialAndCoalescedFrames();
  TestFrameCodecRejectsInvalidLengths();
  TestEnvelopeRoundTripAndValidation();
  TestStateMachineIsIdempotentAndTerminal();
  TestBoundedQueueWrapAndFullState();
  TestUtf16UnitLimitHandlesAstralText();
  TestUtf8ValidationAndConstantTimeComparison();
  if (failures != 0) {
    std::cerr << failures << " test(s) failed\n";
    return 1;
  }
  std::cout << "all native core tests passed\n";
  return 0;
}
