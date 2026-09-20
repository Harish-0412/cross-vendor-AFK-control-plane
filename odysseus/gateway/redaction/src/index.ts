// Named re-exports are `export * from` below; this module additionally
// imports the same bindings (without re-exporting them a second time — that
// previously produced duplicate ESM export bindings for every name here,
// the same class of bug found and fixed in gateway/sandbox/src/index.ts)
// purely to assemble the `Redaction` default-export namespace object.
export * from './types';
export * from './patterns';
export * from './redactor';
export * from './classifier';
export * from './redaction-proxy';

import { createDataBoundary } from './classifier';
import {
  BUILTIN_PATTERNS,
  getAllPatterns,
  getPatternsByType,
  createPatternRegistry,
} from './patterns';
import { createRedactor, StreamingRedactor, calculateEntropy, isHighEntropy } from './redactor';

export const Redaction = {
  createRedactor,
  createDataBoundary,
  StreamingRedactor,
  calculateEntropy,
  isHighEntropy,
  patterns: {
    builtin: BUILTIN_PATTERNS,
    getAll: getAllPatterns,
    getByType: getPatternsByType,
    createRegistry: createPatternRegistry,
  },
};

export default Redaction;
