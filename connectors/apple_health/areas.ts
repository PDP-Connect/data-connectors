// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The health area, and so the stream, that each Record type belongs to.
 *
 * One table, keyed by the identifier the export writes in a Record's `type`
 * attribute. The areas are the topic groups of Apple's HealthKit
 * documentation (developer.apple.com/documentation/healthkit): the pages for
 * HKQuantityTypeIdentifier and HKCategoryTypeIdentifier group their
 * identifiers under Activity, Body measurements, Reproductive health,
 * Hearing, Vital signs, Lab and test results, Mindfulness and sleep,
 * Nutrition, Alcohol consumption, Mobility, UV exposure, Diving and Self
 * care, and the category symptoms have their own page, "Symptom type
 * identifiers". Each group comment below names the group an entry comes
 * from. Two groups are adjusted: Mindfulness and sleep is split in two,
 * because a grant of sleep data is not a grant of mindfulness sessions, and
 * UV exposure, Diving and Self care share `other` with every type the table
 * does not list.
 *
 * Keys are the constant names the export writes: the HKQuantityTypeIdentifier
 * or HKCategoryTypeIdentifier prefix followed by Apple's Swift name with its
 * first letter capitalised, except where the constant spells an acronym in
 * capitals (HKQuantityTypeIdentifierVO2Max, HKQuantityTypeIdentifierUVExposure).
 * HKDataTypeSleepDurationGoal is a type the export writes that has no
 * HealthKit identifier. Correlation types (blood pressure, food) are
 * containers rather than records: the export nests their member Records,
 * which are read like any other.
 *
 * ONE DELIBERATE DEVIATION. Apple files three symptoms under "Reproduction":
 * breast pain, pelvic pain and vaginal dryness. They map to
 * reproductive_health rather than symptoms, so that reproductive information
 * is shared only through that stream's own grant; left in symptoms, a grant
 * given for headaches and coughs would carry them too. The manifest says so
 * on both streams.
 *
 * A type the table does not list maps to `other`, never to nothing: an
 * identifier Apple adds after this table was written is still delivered, and
 * the other stream's receipt counts it (records_type_unrecognized), so the
 * owner can see that something arrived without an area.
 */

/** The health-area streams, in the order the manifest declares them. */
export const HEALTH_AREA_STREAMS = [
	"activity",
	"body_measurements",
	"reproductive_health",
	"hearing",
	"vital_signs",
	"lab_results",
	"sleep",
	"mindfulness",
	"nutrition",
	"alcohol_consumption",
	"mobility",
	"symptoms",
	"other",
] as const;

export type HealthAreaStream = (typeof HEALTH_AREA_STREAMS)[number];

/** Export identifier to health-area stream. See the file header for the source and the one deviation. */
export const HEALTH_AREA_BY_IDENTIFIER: Readonly<
	Record<string, HealthAreaStream>
> = Object.freeze({
	// Activity (HKQuantityTypeIdentifier and HKCategoryTypeIdentifier: Activity)
	HKQuantityTypeIdentifierStepCount: "activity",
	HKQuantityTypeIdentifierDistanceWalkingRunning: "activity",
	HKQuantityTypeIdentifierRunningGroundContactTime: "activity",
	HKQuantityTypeIdentifierRunningPower: "activity",
	HKQuantityTypeIdentifierRunningSpeed: "activity",
	HKQuantityTypeIdentifierRunningStrideLength: "activity",
	HKQuantityTypeIdentifierRunningVerticalOscillation: "activity",
	HKQuantityTypeIdentifierDistanceCycling: "activity",
	HKQuantityTypeIdentifierPushCount: "activity",
	HKQuantityTypeIdentifierDistanceWheelchair: "activity",
	HKQuantityTypeIdentifierSwimmingStrokeCount: "activity",
	HKQuantityTypeIdentifierDistanceSwimming: "activity",
	HKQuantityTypeIdentifierDistanceDownhillSnowSports: "activity",
	HKQuantityTypeIdentifierBasalEnergyBurned: "activity",
	HKQuantityTypeIdentifierActiveEnergyBurned: "activity",
	HKQuantityTypeIdentifierFlightsClimbed: "activity",
	HKQuantityTypeIdentifierNikeFuel: "activity",
	HKQuantityTypeIdentifierAppleExerciseTime: "activity",
	HKQuantityTypeIdentifierAppleMoveTime: "activity",
	HKQuantityTypeIdentifierAppleStandTime: "activity",
	HKQuantityTypeIdentifierVO2Max: "activity",
	HKQuantityTypeIdentifierCrossCountrySkiingSpeed: "activity",
	HKQuantityTypeIdentifierCyclingCadence: "activity",
	HKQuantityTypeIdentifierCyclingFunctionalThresholdPower: "activity",
	HKQuantityTypeIdentifierCyclingPower: "activity",
	HKQuantityTypeIdentifierCyclingSpeed: "activity",
	HKQuantityTypeIdentifierDistanceCrossCountrySkiing: "activity",
	HKQuantityTypeIdentifierDistancePaddleSports: "activity",
	HKQuantityTypeIdentifierDistanceRowing: "activity",
	HKQuantityTypeIdentifierDistanceSkatingSports: "activity",
	HKQuantityTypeIdentifierEstimatedWorkoutEffortScore: "activity",
	HKQuantityTypeIdentifierPaddleSportsSpeed: "activity",
	HKQuantityTypeIdentifierPhysicalEffort: "activity",
	HKQuantityTypeIdentifierRowingSpeed: "activity",
	HKQuantityTypeIdentifierWorkoutEffortScore: "activity",
	HKCategoryTypeIdentifierAppleStandHour: "activity",
	HKCategoryTypeIdentifierLowCardioFitnessEvent: "activity",
	// Body measurements (HKQuantityTypeIdentifier: Body measurements)
	HKQuantityTypeIdentifierHeight: "body_measurements",
	HKQuantityTypeIdentifierBodyMass: "body_measurements",
	HKQuantityTypeIdentifierBodyMassIndex: "body_measurements",
	HKQuantityTypeIdentifierLeanBodyMass: "body_measurements",
	HKQuantityTypeIdentifierBodyFatPercentage: "body_measurements",
	HKQuantityTypeIdentifierWaistCircumference: "body_measurements",
	HKQuantityTypeIdentifierAppleSleepingWristTemperature: "body_measurements",
	// Reproductive health (HKQuantityTypeIdentifier and HKCategoryTypeIdentifier:
	// Reproductive health)
	HKQuantityTypeIdentifierBasalBodyTemperature: "reproductive_health",
	HKCategoryTypeIdentifierMenstrualFlow: "reproductive_health",
	HKCategoryTypeIdentifierIntermenstrualBleeding: "reproductive_health",
	HKCategoryTypeIdentifierInfrequentMenstrualCycles: "reproductive_health",
	HKCategoryTypeIdentifierIrregularMenstrualCycles: "reproductive_health",
	HKCategoryTypeIdentifierPersistentIntermenstrualBleeding:
		"reproductive_health",
	HKCategoryTypeIdentifierProlongedMenstrualPeriods: "reproductive_health",
	HKCategoryTypeIdentifierCervicalMucusQuality: "reproductive_health",
	HKCategoryTypeIdentifierOvulationTestResult: "reproductive_health",
	HKCategoryTypeIdentifierProgesteroneTestResult: "reproductive_health",
	HKCategoryTypeIdentifierSexualActivity: "reproductive_health",
	HKCategoryTypeIdentifierContraceptive: "reproductive_health",
	HKCategoryTypeIdentifierPregnancy: "reproductive_health",
	HKCategoryTypeIdentifierPregnancyTestResult: "reproductive_health",
	HKCategoryTypeIdentifierLactation: "reproductive_health",
	HKCategoryTypeIdentifierMenopausalState: "reproductive_health",
	HKCategoryTypeIdentifierBleedingAfterMenopause: "reproductive_health",
	HKCategoryTypeIdentifierBleedingDuringPregnancy: "reproductive_health",
	HKCategoryTypeIdentifierBleedingAfterPregnancy: "reproductive_health",
	// Symptom type identifiers: Reproduction. The deliberate deviation: filed here,
	// not under symptoms (see the header).
	HKCategoryTypeIdentifierBreastPain: "reproductive_health",
	HKCategoryTypeIdentifierPelvicPain: "reproductive_health",
	HKCategoryTypeIdentifierVaginalDryness: "reproductive_health",
	// Hearing (HKQuantityTypeIdentifier and HKCategoryTypeIdentifier: Hearing)
	HKQuantityTypeIdentifierEnvironmentalAudioExposure: "hearing",
	HKQuantityTypeIdentifierEnvironmentalSoundReduction: "hearing",
	HKQuantityTypeIdentifierHeadphoneAudioExposure: "hearing",
	HKCategoryTypeIdentifierEnvironmentalAudioExposureEvent: "hearing",
	HKCategoryTypeIdentifierHeadphoneAudioExposureEvent: "hearing",
	HKCategoryTypeIdentifierAudioExposureEvent: "hearing",
	// Vital signs (HKQuantityTypeIdentifier and HKCategoryTypeIdentifier: Vital signs)
	HKQuantityTypeIdentifierHeartRate: "vital_signs",
	HKQuantityTypeIdentifierRestingHeartRate: "vital_signs",
	HKQuantityTypeIdentifierWalkingHeartRateAverage: "vital_signs",
	HKQuantityTypeIdentifierHeartRateVariabilitySDNN: "vital_signs",
	HKQuantityTypeIdentifierHeartRateVariabilityRMSSD: "vital_signs",
	HKQuantityTypeIdentifierHeartRateRecoveryOneMinute: "vital_signs",
	HKQuantityTypeIdentifierAtrialFibrillationBurden: "vital_signs",
	HKQuantityTypeIdentifierOxygenSaturation: "vital_signs",
	HKQuantityTypeIdentifierBodyTemperature: "vital_signs",
	HKQuantityTypeIdentifierBloodPressureDiastolic: "vital_signs",
	HKQuantityTypeIdentifierBloodPressureSystolic: "vital_signs",
	HKQuantityTypeIdentifierRespiratoryRate: "vital_signs",
	HKCategoryTypeIdentifierLowHeartRateEvent: "vital_signs",
	HKCategoryTypeIdentifierHighHeartRateEvent: "vital_signs",
	HKCategoryTypeIdentifierIrregularHeartRhythmEvent: "vital_signs",
	HKCategoryTypeIdentifierHypertensionEvent: "vital_signs",
	// Lab and test results (HKQuantityTypeIdentifier: Lab and test results)
	HKQuantityTypeIdentifierBloodGlucose: "lab_results",
	HKQuantityTypeIdentifierElectrodermalActivity: "lab_results",
	HKQuantityTypeIdentifierForcedExpiratoryVolume1: "lab_results",
	HKQuantityTypeIdentifierForcedVitalCapacity: "lab_results",
	HKQuantityTypeIdentifierInhalerUsage: "lab_results",
	HKQuantityTypeIdentifierInsulinDelivery: "lab_results",
	HKQuantityTypeIdentifierNumberOfTimesFallen: "lab_results",
	HKQuantityTypeIdentifierPeakExpiratoryFlowRate: "lab_results",
	HKQuantityTypeIdentifierPeripheralPerfusionIndex: "lab_results",
	// Sleep (HKQuantityTypeIdentifier and HKCategoryTypeIdentifier: Mindfulness and
	// sleep), and the export-only sleep duration goal
	HKCategoryTypeIdentifierSleepAnalysis: "sleep",
	HKCategoryTypeIdentifierSleepApneaEvent: "sleep",
	HKQuantityTypeIdentifierAppleSleepingBreathingDisturbances: "sleep",
	HKDataTypeSleepDurationGoal: "sleep",
	// Mindfulness (HKCategoryTypeIdentifier: Mindfulness and sleep)
	HKCategoryTypeIdentifierMindfulSession: "mindfulness",
	// Nutrition (HKQuantityTypeIdentifier: Nutrition)
	HKQuantityTypeIdentifierDietaryBiotin: "nutrition",
	HKQuantityTypeIdentifierDietaryCaffeine: "nutrition",
	HKQuantityTypeIdentifierDietaryCalcium: "nutrition",
	HKQuantityTypeIdentifierDietaryCarbohydrates: "nutrition",
	HKQuantityTypeIdentifierDietaryChloride: "nutrition",
	HKQuantityTypeIdentifierDietaryCholesterol: "nutrition",
	HKQuantityTypeIdentifierDietaryChromium: "nutrition",
	HKQuantityTypeIdentifierDietaryCopper: "nutrition",
	HKQuantityTypeIdentifierDietaryEnergyConsumed: "nutrition",
	HKQuantityTypeIdentifierDietaryFatMonounsaturated: "nutrition",
	HKQuantityTypeIdentifierDietaryFatPolyunsaturated: "nutrition",
	HKQuantityTypeIdentifierDietaryFatSaturated: "nutrition",
	HKQuantityTypeIdentifierDietaryFatTotal: "nutrition",
	HKQuantityTypeIdentifierDietaryFiber: "nutrition",
	HKQuantityTypeIdentifierDietaryFolate: "nutrition",
	HKQuantityTypeIdentifierDietaryIodine: "nutrition",
	HKQuantityTypeIdentifierDietaryIron: "nutrition",
	HKQuantityTypeIdentifierDietaryMagnesium: "nutrition",
	HKQuantityTypeIdentifierDietaryManganese: "nutrition",
	HKQuantityTypeIdentifierDietaryMolybdenum: "nutrition",
	HKQuantityTypeIdentifierDietaryNiacin: "nutrition",
	HKQuantityTypeIdentifierDietaryPantothenicAcid: "nutrition",
	HKQuantityTypeIdentifierDietaryPhosphorus: "nutrition",
	HKQuantityTypeIdentifierDietaryPotassium: "nutrition",
	HKQuantityTypeIdentifierDietaryProtein: "nutrition",
	HKQuantityTypeIdentifierDietaryRiboflavin: "nutrition",
	HKQuantityTypeIdentifierDietarySelenium: "nutrition",
	HKQuantityTypeIdentifierDietarySodium: "nutrition",
	HKQuantityTypeIdentifierDietarySugar: "nutrition",
	HKQuantityTypeIdentifierDietaryThiamin: "nutrition",
	HKQuantityTypeIdentifierDietaryVitaminA: "nutrition",
	HKQuantityTypeIdentifierDietaryVitaminB12: "nutrition",
	HKQuantityTypeIdentifierDietaryVitaminB6: "nutrition",
	HKQuantityTypeIdentifierDietaryVitaminC: "nutrition",
	HKQuantityTypeIdentifierDietaryVitaminD: "nutrition",
	HKQuantityTypeIdentifierDietaryVitaminE: "nutrition",
	HKQuantityTypeIdentifierDietaryVitaminK: "nutrition",
	HKQuantityTypeIdentifierDietaryWater: "nutrition",
	HKQuantityTypeIdentifierDietaryZinc: "nutrition",
	// Alcohol consumption (HKQuantityTypeIdentifier: Alcohol consumption)
	HKQuantityTypeIdentifierBloodAlcoholContent: "alcohol_consumption",
	HKQuantityTypeIdentifierNumberOfAlcoholicBeverages: "alcohol_consumption",
	// Mobility (HKQuantityTypeIdentifier and HKCategoryTypeIdentifier: Mobility)
	HKQuantityTypeIdentifierAppleWalkingSteadiness: "mobility",
	HKQuantityTypeIdentifierSixMinuteWalkTestDistance: "mobility",
	HKQuantityTypeIdentifierWalkingSpeed: "mobility",
	HKQuantityTypeIdentifierWalkingStepLength: "mobility",
	HKQuantityTypeIdentifierWalkingAsymmetryPercentage: "mobility",
	HKQuantityTypeIdentifierWalkingDoubleSupportPercentage: "mobility",
	HKQuantityTypeIdentifierStairAscentSpeed: "mobility",
	HKQuantityTypeIdentifierStairDescentSpeed: "mobility",
	HKCategoryTypeIdentifierAppleWalkingSteadinessEvent: "mobility",
	// Symptoms (Symptom type identifiers, every group but Reproduction)
	HKCategoryTypeIdentifierAbdominalCramps: "symptoms",
	HKCategoryTypeIdentifierBloating: "symptoms",
	HKCategoryTypeIdentifierConstipation: "symptoms",
	HKCategoryTypeIdentifierDiarrhea: "symptoms",
	HKCategoryTypeIdentifierHeartburn: "symptoms",
	HKCategoryTypeIdentifierNausea: "symptoms",
	HKCategoryTypeIdentifierVomiting: "symptoms",
	HKCategoryTypeIdentifierAppetiteChanges: "symptoms",
	HKCategoryTypeIdentifierChills: "symptoms",
	HKCategoryTypeIdentifierDizziness: "symptoms",
	HKCategoryTypeIdentifierFainting: "symptoms",
	HKCategoryTypeIdentifierFatigue: "symptoms",
	HKCategoryTypeIdentifierFever: "symptoms",
	HKCategoryTypeIdentifierGeneralizedBodyAche: "symptoms",
	HKCategoryTypeIdentifierHotFlashes: "symptoms",
	HKCategoryTypeIdentifierChestTightnessOrPain: "symptoms",
	HKCategoryTypeIdentifierCoughing: "symptoms",
	HKCategoryTypeIdentifierRapidPoundingOrFlutteringHeartbeat: "symptoms",
	HKCategoryTypeIdentifierShortnessOfBreath: "symptoms",
	HKCategoryTypeIdentifierSkippedHeartbeat: "symptoms",
	HKCategoryTypeIdentifierWheezing: "symptoms",
	HKCategoryTypeIdentifierLowerBackPain: "symptoms",
	HKCategoryTypeIdentifierHeadache: "symptoms",
	HKCategoryTypeIdentifierMemoryLapse: "symptoms",
	HKCategoryTypeIdentifierMoodChanges: "symptoms",
	HKCategoryTypeIdentifierLossOfSmell: "symptoms",
	HKCategoryTypeIdentifierLossOfTaste: "symptoms",
	HKCategoryTypeIdentifierRunnyNose: "symptoms",
	HKCategoryTypeIdentifierSoreThroat: "symptoms",
	HKCategoryTypeIdentifierSinusCongestion: "symptoms",
	HKCategoryTypeIdentifierAcne: "symptoms",
	HKCategoryTypeIdentifierDrySkin: "symptoms",
	HKCategoryTypeIdentifierHairLoss: "symptoms",
	HKCategoryTypeIdentifierNightSweats: "symptoms",
	HKCategoryTypeIdentifierSleepChanges: "symptoms",
	HKCategoryTypeIdentifierBladderIncontinence: "symptoms",
	// Other (HKQuantityTypeIdentifier: UV exposure and Diving; HKCategoryTypeIdentifier:
	// Self care). Listed so that they are known types, not unfamiliar ones.
	HKQuantityTypeIdentifierUVExposure: "other",
	HKQuantityTypeIdentifierTimeInDaylight: "other",
	HKQuantityTypeIdentifierUnderwaterDepth: "other",
	HKQuantityTypeIdentifierWaterTemperature: "other",
	HKCategoryTypeIdentifierToothbrushingEvent: "other",
	HKCategoryTypeIdentifierHandwashingEvent: "other",
});

/** Whether the table lists this type. Own keys only, so a type named after an Object.prototype member is not listed. */
export function isListedHealthType(type: string | undefined): boolean {
	return type !== undefined && Object.hasOwn(HEALTH_AREA_BY_IDENTIFIER, type);
}

/** The stream a Record of this type belongs to: its area, or `other` when the table does not list it. */
export function healthAreaOf(type: string | undefined): HealthAreaStream {
	if (type === undefined || !isListedHealthType(type)) {
		return "other";
	}
	return HEALTH_AREA_BY_IDENTIFIER[type] ?? "other";
}
