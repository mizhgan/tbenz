const GdebenzStation = require('../models/GdebenzStation');
const gdebenzClient = require('./gdebenzClient');
const gdebenzParser = require('./gdebenzParser');
const SberazsStation = require('../models/SberazsStation');
const sberazsClient = require('./sberazsClient');
const sberazsParser = require('./sberazsParser');
const { gdebenzEnabled, sberazsEnabled } = require('../config/env');

// Single place that lists every *secondary* fuel-availability source (i.e.
// every source besides tbank itself). tbank stays special-cased everywhere
// else in the codebase - it's the source Station documents are created and
// deduped from (see ingestService.storeStation), not just another entry
// matched onto an existing Station - so it deliberately isn't listed here.
//
// Adding a future source #3 means: its own raw collection/model, client,
// parser (mirroring GdebenzStation.js/gdebenzClient.js/gdebenzParser.js),
// and one entry pushed onto this array - ingest, matching, merge, and the
// admin/map UI all read this list rather than hardcoding a second named
// source the way they hardcode gdebenz today.
//
// `weight` is the trust weight used by mergeStatusService's N-way merge -
// seeded at 1.0 (equal trust with tbank) so introducing this registry is
// not itself a behavior change. Deliberately changing a source's weight
// away from 1.0 is a separate, explicit policy decision - see the doc
// comment on mergeStatusService.js.
const SOURCES = [
  {
    key: 'gdebenz',
    label: 'gdebenz.ru',
    model: GdebenzStation,
    weight: 1.0,
    get enabled() {
      return gdebenzEnabled;
    },
    // Uniform names so a generic ingest runner (see
    // secondarySourceIngestService.js) can call any registered source the
    // same way, without needing to know gdebenzParser.js's own more
    // descriptive (gdebenz-specific) export names.
    fetchStations: gdebenzClient.fetchStations,
    buildRequestUrl: gdebenzClient.buildRequestUrl,
    extractStationsArray: gdebenzParser.extractGdebenzStationsArray,
    parseStation: gdebenzParser.parseGdebenzStation,
  },
  {
    key: 'sberazs',
    label: 'sberazs.ru',
    model: SberazsStation,
    // Weighted at 0, not just "low" - a deliberate exception to the
    // "seed new sources at 1.0" rule above, per an explicit call: sberazs's
    // `availabilityStatus` is inferred from whether *any* recent card
    // payment happened at the location at all, not a fuel purchase
    // specifically (could be a shop/car wash at the same site), and its
    // `fuels` list is the station's permanent equipment (which pumps it
    // has), not a live availability signal the way gdebenz's `fuels_now` is
    // - so it isn't just "less trustworthy per source", it's structurally
    // not evidence of fuel availability at all.
    //
    // resolveVotes' weighted average cancels out weight entirely when a
    // source is the *only* one voting on a station (score = its own
    // reading regardless of how small a positive weight is) - so any
    // weight > 0 would still let sberazs single-handedly assert a
    // confirmed status on stations tbank/gdebenz have nothing to say
    // about. 0 is the one value that actually keeps it at zero influence
    // in every case (see resolveVotes' totalWeight <= 0 guard), including
    // that one - it still shows up as its own tile/row in the admin UI for
    // a human to weigh, it just never moves the canonical merged status
    // metrics/reports/Telegram/bot read.
    weight: 0,
    get enabled() {
      return sberazsEnabled;
    },
    fetchStations: sberazsClient.fetchStations,
    buildRequestUrl: sberazsClient.buildRequestUrl,
    extractStationsArray: sberazsParser.extractStationsArray,
    parseStation: sberazsParser.parseStation,
  },
];

function listSources({ onlyEnabled = true } = {}) {
  return onlyEnabled ? SOURCES.filter((s) => s.enabled) : SOURCES;
}

function getSource(key) {
  return SOURCES.find((s) => s.key === key) || null;
}

module.exports = { listSources, getSource };
