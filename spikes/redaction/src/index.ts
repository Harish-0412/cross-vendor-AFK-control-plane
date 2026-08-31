export * from './types';
export * from './patterns';
export * from './redactor';
export * from './classifier';

import { DefaultRedactor, createRedactor, StreamingRedactor, calculateEntropy, isHighEntropy } from './redactor';
import { DefaultClassifier, DataBoundary, createDataBoundary } from './classifier';
import { BUILTIN_PATTERNS, getAllPatterns, getPatternsByType, createPatternRegistry } from './patterns';

export {
  DefaultRedactor,
  createRedactor,
  StreamingRedactor,
  calculateEntropy,
  isHighEntropy,
  DefaultClassifier,
  DataBoundary,
  createDataBoundary,
  BUILTIN_PATTERNS,
  getAllPatterns,
  getPatternsByType,
  createPatternRegistry
};

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
    createRegistry: createPatternRegistry
  }
};

export default Redaction;