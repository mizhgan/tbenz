// Region.sourcePollStatus's one write path - one entry per source (tbank
// included, as just another sourceKey) upserted in place rather than pushed
// as a duplicate every poll tick. Shared by ingestService.js (tbank) and
// secondarySourceIngestService.js (every other registered source) so both
// write the exact same shape - see Region.js's own doc comment on
// sourcePollStatus for why this used to be two different shapes (tbank on
// dedicated top-level Region fields, everyone else here) and isn't anymore.
//
// requestUrl/rawResponse are optional: the error path always has a URL
// (built independently of the failed request) but never a response, and
// omitting rawResponse there (rather than passing null) leaves whatever
// real response is already stored from this source's last success in place
// instead of wiping it.
function setSourcePollStatus(region, sourceKey, { lastPolledAt, status, error, stationCount, requestUrl, rawResponse }) {
  const patch = { lastPolledAt, status, error, stationCount };
  if (requestUrl !== undefined) patch.requestUrl = requestUrl;
  if (rawResponse !== undefined) patch.rawResponse = rawResponse;

  const entry = region.sourcePollStatus.find((s) => s.sourceKey === sourceKey);
  if (entry) {
    Object.assign(entry, patch);
  } else {
    region.sourcePollStatus.push({ sourceKey, ...patch });
  }
}

module.exports = { setSourcePollStatus };
