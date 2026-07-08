import { defineStore } from 'pinia';

const STORAGE_KEY = 'fuelColors';

// Default palette assigned to fuel types the user hasn't customized. Picking
// the default color by a hash of the fuel type string (rather than by its
// position in whatever chart happens to be rendering) keeps a given fuel
// type's color stable everywhere, regardless of which other fuel types are
// present in a particular station's data.
export const DEFAULT_FUEL_PALETTE = [
  '#2563eb', '#7c3aed', '#0891b2', '#be185d', '#4d7c0f', '#ca8a04', '#4338ca', '#0f766e',
];

// FNV-1a: short, similar-looking inputs like "92"/"95"/"98" need a hash with
// good avalanche behavior to land in different buckets - a naive polynomial
// hash with a small modulus collided between "92" and "98" in practice.
function hashIndex(str, mod) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % mod;
}

export function defaultFuelColor(fuelType) {
  return DEFAULT_FUEL_PALETTE[hashIndex(String(fuelType), DEFAULT_FUEL_PALETTE.length)];
}

function loadOverrides() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function persist(overrides) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
}

export const useFuelColorsStore = defineStore('fuelColors', {
  state: () => ({
    overrides: loadOverrides(),
  }),
  getters: {
    colorFor: (state) => (fuelType) => state.overrides[fuelType] || defaultFuelColor(fuelType),
    isCustom: (state) => (fuelType) => Boolean(state.overrides[fuelType]),
    customizedTypes: (state) => Object.keys(state.overrides),
  },
  actions: {
    setColor(fuelType, color) {
      this.overrides[fuelType] = color;
      persist(this.overrides);
    },
    resetColor(fuelType) {
      delete this.overrides[fuelType];
      persist(this.overrides);
    },
    resetAll() {
      this.overrides = {};
      persist(this.overrides);
    },
  },
});
