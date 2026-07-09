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
    extractStationsArray: gdebenzParser.extractGdebenzStationsArray,
    parseStation: gdebenzParser.parseGdebenzStation,
  },
  {
    key: 'sberazs',
    label: 'sberazs.ru',
    model: SberazsStation,
    weight: 1.0,
    get enabled() {
      return sberazsEnabled;
    },
    fetchStations: sberazsClient.fetchStations,
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
