// ==============================================================================
// High-Altitude LULC Classification (2009) - Kullu & Lahaul-Spiti, Himachal Pradesh
// Platform: Google Earth Engine (JavaScript API)
// Sensor: Landsat 5 TM (Post-Monsoon Seasonal Composite: July 15 - Oct 15)
// Classifier: Supervised Random Forest (150 Trees) + DEM/JRC Post-Refinement
// ==============================================================================

// 1. Define Study Area Boundary: Kullu + Lahaul & Spiti Districts
var hp = ee.FeatureCollection('FAO/GAUL/2015/level2')
  .filter(ee.Filter.eq('ADM1_NAME', 'Himachal Pradesh'));

var districts = hp.filter(ee.Filter.or([
  ee.Filter.eq('ADM2_NAME', 'Kullu'),
  ee.Filter.stringContains('ADM2_NAME', 'Lah')
]));

Map.centerObject(districts, 8);
Map.addLayer(districts, {color: 'yellow'}, 'Study Area Boundary', true);

// 2. Build Cloud-Free Landsat 5 Composite (July 15 - Oct 15, 2008-2010)
var rawL5 = ee.ImageCollection('LANDSAT/LT05/C02/T1')
  .filterBounds(districts)
  .filter(ee.Filter.calendarRange(2008, 2010, 'year'))
  .filter(ee.Filter.dayOfYear(196, 288)) // July 15 to Oct 15
  .filter(ee.Filter.lt('CLOUD_COVER', 40));

// 25th-percentile cloud-scoring composite removes seasonal clouds & scan gaps
var l5_2009 = ee.Algorithms.Landsat.simpleComposite({
  collection: rawL5,
  percentile: 25,
  cloudScoreRange: 10,
  asFloat: true
}).clip(districts);

// 3. Compute Spectral Indices & Terrain Derivatives
var ndvi = l5_2009.normalizedDifference(['B4', 'B3']).rename('NDVI');
var ndsi = l5_2009.normalizedDifference(['B2', 'B5']).rename('NDSI');
var ndwi = l5_2009.normalizedDifference(['B2', 'B4']).rename('NDWI');
var ndbi = l5_2009.normalizedDifference(['B5', 'B4']).rename('NDBI');

var dem = ee.Image('USGS/SRTMGL1_003').clip(districts);
var elevation = dem.select('elevation').rename('ELEV');
var slope = ee.Terrain.slope(dem).rename('SLOPE');

var input2009 = l5_2009.select(['B1', 'B2', 'B3', 'B4', 'B5', 'B7'])
  .addBands([ndvi, ndsi, ndwi, ndbi, elevation, slope]);

// Display Reference Composites
Map.addLayer(input2009, {bands: ['B3', 'B2', 'B1'], min: 0.03, max: 0.45}, '2009 Clean True Color');
Map.addLayer(input2009, {bands: ['B5', 'B4', 'B3'], min: 0.03, max: 0.50}, '2009 Snow vs Barren View', false);
Map.addLayer(input2009, {bands: ['B4', 'B3', 'B2'], min: 0.03, max: 0.45}, '2009 Vegetation False Color', false);

// 4. Load Stratified Reference Samples (461 Points Across 7 Classes)
// Classes: 0=Snow, 1=Water, 2=Forest, 3=Alpine Grassland, 4=Agriculture, 5=Built-up, 6=Barren
var trainingData = ee.FeatureCollection('users/muskan10f/Training_LULC_2009');

// 5. Sample Spectral Bands & Train Random Forest Classifier (70/30 Split)
var spectralBands = ['B1', 'B2', 'B3', 'B4', 'B5', 'B7', 'NDVI', 'NDSI', 'NDWI', 'NDBI'];

var samples = input2009.select(spectralBands).sampleRegions({
  collection: trainingData,
  properties: ['landcover'],
  scale: 30
}).randomColumn('random');

var trainSet = samples.filter(ee.Filter.lt('random', 0.7));
var testSet = samples.filter(ee.Filter.gte('random', 0.7));

var classifier = ee.Classifier.smileRandomForest(150).train({
  features: trainSet,
  classProperty: 'landcover',
  inputProperties: spectralBands
});

var rawClassified = input2009.select(spectralBands).classify(classifier);

// 6. Rule-Based Post-Classification Refinement (DEM + JRC Global Surface Water)
var jrcWater = ee.Image('JRC/GSW1_4/GlobalSurfaceWater')
  .select('occurrence').gt(25).unmask(0).clip(districts);

var classified2009 = rawClassified
  // Remove topographic shadow misclassification on steep slopes (> 20 deg)
  .where(rawClassified.eq(1).and(slope.gt(20)), 6)
  // Preserve sub-pixel fluvial continuity using JRC Global Surface Water
  .where(jrcWater.eq(1), 1)
  // Enforce NDSI snow threshold (< 0.42 converted to Barren)
  .where(rawClassified.eq(0).and(ndsi.lt(0.42)), 6)
  // Eliminate high-elevation/steep false Built-up (> 3750 m or > 12 deg slope)
  .where(rawClassified.eq(5).and(elevation.gt(3750).or(slope.gt(12))), 6)
  // Refine valley agricultural terraces (NDVI > 0.48, slope < 14 deg, elevation < 3850 m)
  .where((rawClassified.eq(2).or(rawClassified.eq(3))).and(ndvi.gt(0.48)).and(slope.lt(14)).and(elevation.lt(3850)), 4);

// 7. Accuracy Assessment (Confusion Matrix, Overall Accuracy & Kappa)
var validated = testSet.classify(classifier);
var errorMatrix = validated.errorMatrix('landcover', 'classification');
print('2009 Overall Accuracy:', errorMatrix.accuracy());
print('2009 Kappa Coefficient:', errorMatrix.kappa());
print('2009 Confusion Matrix:', errorMatrix);

// 8. Visualization Palette
// 0:Snow(White), 1:Water(Blue), 2:Forest(Dark Green), 3:Grass(Light Green), 4:Agri(Yellow), 5:Built-up(Red), 6:Barren(Sandy Tan)
var palette = ['ffffff', '0000ff', '006400', '90ee90', 'ffff00', 'ff0000', 'd9b382'];
Map.addLayer(classified2009, {min: 0, max: 6, palette: palette}, 'LULC 2009 (Final)');

// 9. Export Classified GeoTIFF to Google Drive
Export.image.toDrive({
  image: classified2009.toByte(),
  description: 'LULC_2009_Lahaul_Spiti_Kullu',
  scale: 30,
  region: districts.geometry(),
  maxPixels: 1e13
});

// 10. Export Accuracy Report as CSV to Google Drive
var accuracyFeatures = ee.FeatureCollection([
  ee.Feature(null, {Metric: 'Overall Accuracy', Value: errorMatrix.accuracy()}),
  ee.Feature(null, {Metric: 'Kappa Coefficient', Value: errorMatrix.kappa()}),
  ee.Feature(null, {Metric: 'Producers Accuracy (Classes 0-6)', Value: errorMatrix.producersAccuracy().toList()}),
  ee.Feature(null, {Metric: 'Users Accuracy (Classes 0-6)', Value: errorMatrix.consumersAccuracy().toList()}),
  ee.Feature(null, {Metric: 'Confusion Matrix (Rows 0-6)', Value: errorMatrix.array()})
]);

Export.table.toDrive({
  collection: accuracyFeatures,
  description: 'Accuracy_Report_2009',
  fileFormat: 'CSV'
});

// 11. Calculate & Export Class-Wise Area (sq. km) and Percentage (%) as CSV
var classNames = [
  '0: Snow / Glacier',
  '1: Water Bodies',
  '2: Dense Forest',
  '3: Alpine Grassland',
  '4: Agricultural Land',
  '5: Built-up',
  '6: Barren / Cold Desert'
];

var areaImage = ee.Image.pixelArea().divide(1e6).addBands(classified2009);
var areas = areaImage.reduceRegion({
  reducer: ee.Reducer.sum().group({groupField: 1, groupName: 'class'}),
  geometry: districts.geometry(),
  scale: 30,
  maxPixels: 1e13
});

var groupsList = ee.List(areas.get('groups'));
var totalArea = ee.Number(
  groupsList.map(function(item) {
    return ee.Dictionary(item).get('sum');
  }).reduce(ee.Reducer.sum())
);

var areaFeatures = ee.FeatureCollection(
  groupsList.map(function(item) {
    var dict = ee.Dictionary(item);
    var classId = ee.Number(dict.get('class'));
    var areaSqKm = ee.Number(dict.get('sum'));
    var pct = areaSqKm.divide(totalArea).multiply(100);
    return ee.Feature(null, {
      Class_ID: classId,
      Class_Name: ee.List(classNames).get(classId),
      Area_Sq_Km: areaSqKm,
      Percentage: pct
    });
  })
);

Export.table.toDrive({
  collection: areaFeatures,
  description: 'LULC_Area_Table_2009',
  fileFormat: 'CSV',
  selectors: ['Class_ID', 'Class_Name', 'Area_Sq_Km', 'Percentage']
});
