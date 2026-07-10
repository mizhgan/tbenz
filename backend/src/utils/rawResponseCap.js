// Caps how much of a source's raw API response gets persisted onto the
// Region document (see ingestService.js/secondarySourceIngestService.js) -
// unlike SourcePollLog (a bounded, TTL'd collection), Region is a small,
// frequently read/written document, so an unexpectedly huge payload here
// shouldn't be allowed to bloat it indefinitely. Stored as-is (not
// stringified) when it fits, so the admin UI can pretty-print real JSON
// structure rather than a giant single-line string.
const MAX_RAW_RESPONSE_CHARS = 200_000;

function capRawResponse(payload) {
  const json = JSON.stringify(payload);
  if (json === undefined || json.length <= MAX_RAW_RESPONSE_CHARS) return payload;
  return {
    truncated: true,
    originalLength: json.length,
    note: `Response too large to store in full (${json.length} chars) - showing the first ${MAX_RAW_RESPONSE_CHARS}`,
    preview: json.slice(0, MAX_RAW_RESPONSE_CHARS),
  };
}

module.exports = { capRawResponse };
