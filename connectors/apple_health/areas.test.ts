// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The area table decides which grant a reading travels under, so a type in
 * the wrong area is shared with a reader the owner did not choose for it.
 * These tests hold the table to the mapping it documents, written here
 * independently: Apple's Swift names per area, turned into export
 * identifiers by the naming rule rather than copied from the table.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	HEALTH_AREA_BY_IDENTIFIER,
	HEALTH_AREA_STREAMS,
	type HealthAreaStream,
	healthAreaOf,
	isListedHealthType,
} from "./areas.ts";

/** The two constants that spell an acronym in capitals rather than capitalising the Swift name. */
const ACRONYM_CONSTANTS: Readonly<Record<string, string>> = {
	uvExposure: "UVExposure",
	vo2Max: "VO2Max",
};

function constant(prefix: string, swiftName: string): string {
	const tail =
		ACRONYM_CONSTANTS[swiftName] ??
		`${swiftName.charAt(0).toUpperCase()}${swiftName.slice(1)}`;
	return `${prefix}${tail}`;
}

function names(list: string): string[] {
	return list.split(/[\s,]+/).filter((n) => n.length > 0);
}

const quantity = (list: string): string[] =>
	names(list).map((n) => constant("HKQuantityTypeIdentifier", n));
const category = (list: string): string[] =>
	names(list).map((n) => constant("HKCategoryTypeIdentifier", n));

const EXPECTED: Readonly<Record<HealthAreaStream, readonly string[]>> = {
	activity: [
		...quantity(`stepCount, distanceWalkingRunning, runningGroundContactTime, runningPower,
			runningSpeed, runningStrideLength, runningVerticalOscillation, distanceCycling, pushCount,
			distanceWheelchair, swimmingStrokeCount, distanceSwimming, distanceDownhillSnowSports,
			basalEnergyBurned, activeEnergyBurned, flightsClimbed, nikeFuel, appleExerciseTime,
			appleMoveTime, appleStandTime, vo2Max, crossCountrySkiingSpeed, cyclingCadence,
			cyclingFunctionalThresholdPower, cyclingPower, cyclingSpeed, distanceCrossCountrySkiing,
			distancePaddleSports, distanceRowing, distanceSkatingSports, estimatedWorkoutEffortScore,
			paddleSportsSpeed, physicalEffort, rowingSpeed, workoutEffortScore`),
		...category("appleStandHour, lowCardioFitnessEvent"),
	],
	body_measurements: quantity(`height, bodyMass, bodyMassIndex, leanBodyMass,
		bodyFatPercentage, waistCircumference, appleSleepingWristTemperature`),
	reproductive_health: [
		...quantity("basalBodyTemperature"),
		...category(`menstrualFlow, intermenstrualBleeding, infrequentMenstrualCycles,
			irregularMenstrualCycles, persistentIntermenstrualBleeding, prolongedMenstrualPeriods,
			cervicalMucusQuality, ovulationTestResult, progesteroneTestResult, sexualActivity,
			contraceptive, pregnancy, pregnancyTestResult, lactation, menopausalState,
			bleedingAfterMenopause, bleedingDuringPregnancy, bleedingAfterPregnancy`),
		...category("breastPain, pelvicPain, vaginalDryness"),
	],
	hearing: [
		...quantity(
			"environmentalAudioExposure, environmentalSoundReduction, headphoneAudioExposure",
		),
		...category(
			"environmentalAudioExposureEvent, headphoneAudioExposureEvent, audioExposureEvent",
		),
	],
	vital_signs: [
		...quantity(`heartRate, restingHeartRate, walkingHeartRateAverage,
			heartRateVariabilitySDNN, heartRateVariabilityRMSSD, heartRateRecoveryOneMinute,
			atrialFibrillationBurden, oxygenSaturation, bodyTemperature, bloodPressureDiastolic,
			bloodPressureSystolic, respiratoryRate`),
		...category(
			"lowHeartRateEvent, highHeartRateEvent, irregularHeartRhythmEvent, hypertensionEvent",
		),
	],
	lab_results:
		quantity(`bloodGlucose, electrodermalActivity, forcedExpiratoryVolume1,
		forcedVitalCapacity, inhalerUsage, insulinDelivery, numberOfTimesFallen,
		peakExpiratoryFlowRate, peripheralPerfusionIndex`),
	sleep: [
		...category("sleepAnalysis, sleepApneaEvent"),
		...quantity("appleSleepingBreathingDisturbances"),
		"HKDataTypeSleepDurationGoal",
	],
	mindfulness: category("mindfulSession"),
	nutrition:
		quantity(`dietaryBiotin, dietaryCaffeine, dietaryCalcium, dietaryCarbohydrates,
		dietaryChloride, dietaryCholesterol, dietaryChromium, dietaryCopper, dietaryEnergyConsumed,
		dietaryFatMonounsaturated, dietaryFatPolyunsaturated, dietaryFatSaturated, dietaryFatTotal,
		dietaryFiber, dietaryFolate, dietaryIodine, dietaryIron, dietaryMagnesium, dietaryManganese,
		dietaryMolybdenum, dietaryNiacin, dietaryPantothenicAcid, dietaryPhosphorus,
		dietaryPotassium, dietaryProtein, dietaryRiboflavin, dietarySelenium, dietarySodium,
		dietarySugar, dietaryThiamin, dietaryVitaminA, dietaryVitaminB12, dietaryVitaminB6,
		dietaryVitaminC, dietaryVitaminD, dietaryVitaminE, dietaryVitaminK, dietaryWater,
		dietaryZinc`),
	alcohol_consumption: quantity(
		"bloodAlcoholContent, numberOfAlcoholicBeverages",
	),
	mobility: [
		...quantity(`appleWalkingSteadiness, sixMinuteWalkTestDistance, walkingSpeed,
			walkingStepLength, walkingAsymmetryPercentage, walkingDoubleSupportPercentage,
			stairAscentSpeed, stairDescentSpeed`),
		...category("appleWalkingSteadinessEvent"),
	],
	symptoms:
		category(`abdominalCramps, bloating, constipation, diarrhea, heartburn, nausea,
		vomiting, appetiteChanges, chills, dizziness, fainting, fatigue, fever, generalizedBodyAche,
		hotFlashes, chestTightnessOrPain, coughing, rapidPoundingOrFlutteringHeartbeat,
		shortnessOfBreath, skippedHeartbeat, wheezing, lowerBackPain, headache, memoryLapse,
		moodChanges, lossOfSmell, lossOfTaste, runnyNose, soreThroat, sinusCongestion, acne,
		drySkin, hairLoss, nightSweats, sleepChanges, bladderIncontinence`),
	other: [
		...quantity(
			"uvExposure, timeInDaylight, underwaterDepth, waterTemperature",
		),
		...category("toothbrushingEvent, handwashingEvent"),
	],
};

/** How many identifiers each area lists, so a list that silently shrank here would fail too. */
const EXPECTED_COUNTS: Readonly<Record<HealthAreaStream, number>> = {
	activity: 37,
	body_measurements: 7,
	reproductive_health: 22,
	hearing: 6,
	vital_signs: 16,
	lab_results: 9,
	sleep: 4,
	mindfulness: 1,
	nutrition: 39,
	alcohol_consumption: 2,
	mobility: 9,
	symptoms: 36,
	other: 6,
};

test("every documented identifier maps to its area's stream", () => {
	for (const stream of HEALTH_AREA_STREAMS) {
		const ids = EXPECTED[stream];
		assert.equal(ids.length, EXPECTED_COUNTS[stream], `${stream} list length`);
		for (const id of ids) {
			assert.equal(healthAreaOf(id), stream, `${id} belongs to ${stream}`);
			assert.equal(isListedHealthType(id), true, `${id} is listed`);
		}
	}
});

test("the table lists exactly the documented identifiers, each once", () => {
	const expected = HEALTH_AREA_STREAMS.flatMap((s) => EXPECTED[s]);
	assert.equal(
		new Set(expected).size,
		expected.length,
		"no identifier is documented under two areas",
	);
	assert.deepEqual(
		Object.keys(HEALTH_AREA_BY_IDENTIFIER).sort(),
		[...expected].sort(),
		"the table and the documented mapping must list the same identifiers",
	);
});

test("the three reproduction symptoms go to reproductive_health, not symptoms", () => {
	for (const id of category("breastPain, pelvicPain, vaginalDryness")) {
		assert.equal(healthAreaOf(id), "reproductive_health");
	}
});

test("a type the table does not list goes to other and is never dropped", () => {
	for (const type of [
		"HKQuantityTypeIdentifierSomethingAppleAddsLater",
		"HKCategoryTypeIdentifierSomethingAppleAddsLater",
		"HKBiomarkerTypeIdentifierFutureBiomarker",
		"HKCorrelationTypeIdentifierBloodPressure",
		// The published short form and a different case are not export identifiers.
		"StepCount",
		"hkquantitytypeidentifierstepcount",
		"",
		undefined,
	]) {
		assert.equal(healthAreaOf(type), "other", String(type));
		assert.equal(isListedHealthType(type), false, String(type));
	}
});

test("a type named after an Object.prototype member is not mistaken for a listed one", () => {
	// A lookup through the prototype chain would return a function for
	// "constructor" and route the record to a stream named after it.
	for (const type of [
		"constructor",
		"__proto__",
		"toString",
		"hasOwnProperty",
		"valueOf",
	]) {
		assert.equal(healthAreaOf(type), "other", type);
		assert.equal(isListedHealthType(type), false, type);
	}
});

test("every table value is a declared area stream", () => {
	const streams = new Set<string>(HEALTH_AREA_STREAMS);
	for (const [id, stream] of Object.entries(HEALTH_AREA_BY_IDENTIFIER)) {
		assert.ok(streams.has(stream), `${id} maps to undeclared ${stream}`);
	}
});
