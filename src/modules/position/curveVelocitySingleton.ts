import { VelocityAnalyzer } from '../graduation-predictor/VelocityAnalyzer.js';

/** Single shared analyzer — avoids per-tick `new VelocityAnalyzer()` (GC + map churn). */
let instance: VelocityAnalyzer | null = null;

export function getCurveVelocityAnalyzer(): VelocityAnalyzer {
  if (!instance) {
    instance = new VelocityAnalyzer();
  }
  return instance;
}
