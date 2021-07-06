// simplify freak calculation compared to detector 4
const tf = require('@tensorflow/tfjs');
const {FREAKPOINTS} = require('./freak');

const PYRAMID_NUM_SCALES_PER_OCTAVES = 3;
const PYRAMID_MIN_SIZE = 8;
const PYRAMID_MAX_OCTAVE = 5;

const LAPLACIAN_THRESHOLD = 3.0;
//const LAPLACIAN_THRESHOLD = 0.0001;
const LAPLACIAN_SQR_THRESHOLD = LAPLACIAN_THRESHOLD * LAPLACIAN_THRESHOLD;
const MAX_SUBPIXEL_DISTANCE_SQR = 3 * 3;
const EDGE_THRESHOLD = 4.0;
const EDGE_HESSIAN_THRESHOLD = ((EDGE_THRESHOLD+1) * (EDGE_THRESHOLD+1) / EDGE_THRESHOLD);

const NUM_BUCKETS_PER_DIMENSION = 10;
const MAX_FEATURES_PER_BUCKET = 5;
const NUM_BUCKETS = NUM_BUCKETS_PER_DIMENSION * NUM_BUCKETS_PER_DIMENSION;
// total max feature points = NUM_BUCKETS * MAX_FEATURES_PER_BUCKET

const ORIENTATION_NUM_BINS = 36;
const ORIENTATION_SMOOTHING_ITERATIONS = 5;

const ORIENTATION_GAUSSIAN_EXPANSION_FACTOR = 3.0;
const ORIENTATION_REGION_EXPANSION_FACTOR = 1.5;
const FREAK_EXPANSION_FACTOR = 7.0;
const ORIENTATION_EXPANSION_FACTOR = 4.5;

const FREAK_CONPARISON_COUNT = (FREAKPOINTS.length-1) * (FREAKPOINTS.length) / 2; // 666

class Detector {
  constructor(width, height, debugMode=false) {
    this.debugMode = debugMode;
    this.width = width;
    this.height = height;

    let numOctaves = 0;
    while (width >= PYRAMID_MIN_SIZE && height >= PYRAMID_MIN_SIZE) {
      width /= 2;
      height /= 2;
      numOctaves++;
      if (numOctaves === PYRAMID_MAX_OCTAVE) break;
    }
    this.numOctaves = numOctaves;

    this.tensorCaches = {};
    this.kernelCaches = {};
  }

  // used in compiler
  detectImageData(imageData) {
    const arr = new Uint8ClampedArray(4 * imageData.length);
    for (let i = 0; i < imageData.length; i++) {
      arr[4*i] = imageData[i];
      arr[4*i+1] = imageData[i];
      arr[4*i+2] = imageData[i];
      arr[4*i+3] = 255;
    }
    const img = new ImageData(arr, this.width, this.height);
    return this.detect(img);
  }

  detect(inputImageT) {
    console.log("detector6");
    let debugExtra = null;

    // Build gaussian pyramid images
    // two images per octave
    const pyramidImagesT = [];
    for (let i = 0; i < this.numOctaves; i++) {
      let image1T;
      let image2T;
      let image3T;
      if (i === 0) {
	image1T = this._applyFilter(inputImageT);
      } else {
        image1T = this._downsampleBilinear(pyramidImagesT[i-1][2]);
      }
      image2T = this._applyFilter(image1T);
      image3T = this._applyFilter(image2T);
      pyramidImagesT.push([image1T, image2T, image3T]);
      //pyramidImagesT.push([image1T, image2T]);
      //pyramidImagesT.push([image1T, image2T]);
    }

    // Build difference-of-gaussian (dog) pyramid
    const dogPyramidImagesT = [];
    for (let i = 0; i < this.numOctaves; i++) {
      let dogImageT = this._differenceImageBinomial(pyramidImagesT[i][0], pyramidImagesT[i][1]);
      dogPyramidImagesT.push(dogImageT);
    }

    const extremasResultsT = [];
    for (let i = 1; i < this.numOctaves; i++) {
      const dog0 = this._differenceImageBinomial(pyramidImagesT[i-1][1], pyramidImagesT[i-1][2]);
      const dog1 = this._differenceImageBinomial(pyramidImagesT[i][0], pyramidImagesT[i][1]);
      const dog2 = this._differenceImageBinomial(pyramidImagesT[i][1], pyramidImagesT[i][2]);
      const extremasResultT = this._buildExtremas(i, dog0, dog1, dog2);
      //const extremasResultT = this._buildExtremas(i, dogPyramidImagesT[i-1], dogPyramidImagesT[i], dogPyramidImagesT[i+1]);
      extremasResultsT.push(extremasResultT);
    }


    //console.log("ex", tf.gatherND(extremasResults[extremasResults.length-1], [0, 0]).arraySync());
    //return [];

    // divide the input into N by N buckets, and for each bucket,
    // collect the top 5 most significant extrema across extremas in all scale level
    // result would be NUM_BUCKETS x NUM_FEATURES_PER_BUCKET extremas
    const prunedExtremasList = this._applyPrune(extremasResultsT);

    const prunedExtremasT = this._computeLocalization(prunedExtremasList, dogPyramidImagesT);
    //return {featurePoints: [], debugExtra};

    // compute the orientation angle for each pruned extremas
    const extremaHistogramsT = this._computeOrientationHistograms(prunedExtremasT, pyramidImagesT);
    const smoothedHistogramsT = this._smoothHistograms(extremaHistogramsT);
    const extremaAnglesT = this._computeExtremaAngles(smoothedHistogramsT);
    //console.log("extrema hist", extremaHistogramsT.arraySync());
    //console.log("extrema smoothed hist", smoothedHistogramsT.arraySync());

    // to compute freak descriptors, we first the pixel value of 37 freak points for each extrema 
    const extremaFreaksT = this._computeExtremaFreak(pyramidImagesT, prunedExtremasT, extremaAnglesT);

    // compute the bindary descriptors
    const freakDescriptorsT = this._computeFreakDescriptors(extremaFreaksT);

    // combine extrema data and return to cpu
    const combinedExtremasT = this._combine(prunedExtremasT, extremaAnglesT, freakDescriptorsT);
    const combinedExtremasArr = combinedExtremasT.arraySync();

    if (this.debugMode) {
      debugExtra = {
	pyramidImages: pyramidImagesT.map((ts) => ts.map((t) => t.arraySync())),
	dogPyramidImages: dogPyramidImagesT.map((t) => t.arraySync()),
	extremasResults: extremasResultsT.map((t) => t.arraySync()),
	extremaAngles: extremaAnglesT.arraySync(),
	prunedExtremas: prunedExtremasList,
	localizedExtremas: prunedExtremasT.arraySync(),
      }
    }

    pyramidImagesT.forEach((ts) => ts.forEach((t) => t.dispose()));
    dogPyramidImagesT.forEach((t) => t && t.dispose());
    extremasResultsT.forEach((t) => t.dispose());
    prunedExtremasT.dispose();
    extremaHistogramsT.dispose();
    smoothedHistogramsT.dispose();
    extremaAnglesT.dispose();
    extremaFreaksT.dispose();
    freakDescriptorsT.dispose();
    combinedExtremasT.dispose();

    const featurePoints = [];

    for (let i = 0; i < combinedExtremasArr.length; i++) {
      if (combinedExtremasArr[i][0] !== 0) {
	const ext = combinedExtremasArr[i];

	const desc = ext.slice(5);
	// encode descriptors in binary format
	// 37 samples = 1+2+3+...+36 = 666 comparisons = 666 bits
	// ceil(666/32) = 21 (32 bits number)
	const descriptors = [];
	let temp = 0;
	let count = 0;
	for (let m = 0; m < desc.length; m++) {
	  if (desc[m]) temp += 1;
	  count += 1;
	  if (count === 32) {
	    descriptors.push(temp);
	    temp = 0;
	    count = 0;
	  } else {
	    temp = temp * 2;
	  }
	}
	descriptors.push(temp);

	featurePoints.push({
	  maxima: ext[0] > 0,
	  x: ext[1],
	  y: ext[2],
	  scale: ext[3],
	  angle: ext[4],
	  descriptors: descriptors
	});
      }
    }
    console.log("feature points", featurePoints);
    return {featurePoints, debugExtra};
  }

  _combine(prunedExtremas, extremaAngles, freakDescriptors) {
    if (!this.kernelCaches.combine) {
      // first dimension: [score, x, y, scale, angle, freak1, freak2, ..., freak37]
      const kernel =  {
	variableNames: ['extrema', 'angles', 'desc'],
	outputShape: [prunedExtremas.shape[0], 5 + FREAK_CONPARISON_COUNT],
	userCode: `
	  void main() {
	    ivec2 coords = getOutputCoords();
	    int featureIndex = coords[0];
	    int propertyIndex = coords[1];

	    if (propertyIndex == 0) {
	      setOutput(getExtrema(featureIndex, 0));
	      return;
	    }
	    if (propertyIndex == 1) {
	      int extremaIndex = int(getExtrema(featureIndex, 1));
	      int octave = extremaIndex + 1; // ref to buildExtrema, it starts at 2nd octave
	      float x = getExtrema(featureIndex, 3);
	      float originalX = x * pow(2.0, float(octave)) + pow(2.0, float(octave-1)) - 0.5;
	      setOutput(originalX);
	      return;
	    }
	    if (propertyIndex == 2) {
	      int extremaIndex = int(getExtrema(featureIndex, 1));
	      int octave = extremaIndex + 1; // ref to buildExtrema, it starts at 2nd octave
	      float y = getExtrema(featureIndex, 2);
	      float originalY = y * pow(2.0, float(octave)) + pow(2.0, float(octave-1)) - 0.5;
	      setOutput(originalY);
	      return;
	    }
	    if (propertyIndex == 3) {
	      int extremaIndex = int(getExtrema(featureIndex, 1));
	      int octave = extremaIndex + 1; // ref to buildExtrema, it starts at 2nd octave
	      float inputSigma = pow(2., float(octave));
	      setOutput(inputSigma);
	      return;
	    }
	    if (propertyIndex == 4) {
	      setOutput(getAngles(featureIndex));
	      return;
	    }
	    setOutput( getDesc(featureIndex, propertyIndex - 5));
	  }
	`
      }
      this.kernelCaches.combine = [kernel];
    }

    return tf.tidy(() => {
      const [program] = this.kernelCaches.combine;
      return this._compileAndRun(program, [prunedExtremas, extremaAngles, freakDescriptors]);
    });
  }

  _computeFreakDescriptors(extremaFreaks) {
    if (!this.tensorCaches.computeFreakDescriptors) {
      const in1Arr = [];
      const in2Arr = [];
      for (let k1 = 0; k1 < extremaFreaks.shape[1]; k1++) {
	for (let k2 = k1+1; k2 < extremaFreaks.shape[1]; k2++) {
	  in1Arr.push(k1);
	  in2Arr.push(k2);
	}
      }
      const in1 = tf.tensor(in1Arr, [in1Arr.length]).cast('int32');
      const in2 = tf.tensor(in2Arr, [in2Arr.length]).cast('int32');

      this.tensorCaches.computeFreakDescriptors = {
	positionT: tf.keep(tf.stack([in1, in2], 1))
      }
    }
    const {positionT} = this.tensorCaches.computeFreakDescriptors;

    if (!this.kernelCaches.computeFreakDescriptors) {
      const kernel =  {
	variableNames: ['freak', 'p'],
	outputShape: [extremaFreaks.shape[0], FREAK_CONPARISON_COUNT],
	userCode: `
	  void main() {
	    ivec2 coords = getOutputCoords();
	    int featureIndex = coords[0];
	    int descIndex = coords[1];

            int p1 = int(getP(descIndex, 0));
            int p2 = int(getP(descIndex, 1));

	    float v1 = getFreak(featureIndex, p1);
	    float v2 = getFreak(featureIndex, p2);

	    if (v1 < v2 + 0.01) {
	      setOutput(1.);
	      return;
	    }
	    setOutput(0.);
	  }
	`
      }
      this.kernelCaches.computeFreakDescriptors = [kernel];
    }

    return tf.tidy(() => {
      const [program] = this.kernelCaches.computeFreakDescriptors;
      return this._compileAndRun(program, [extremaFreaks, positionT]);
    });
  }

  _computeExtremaFreak(pyramidImagesT, prunedExtremas, prunedExtremasAngles) {
    if (!this.tensorCaches._computeExtremaFreak) {
      tf.tidy(() => {
	const freakPoints = tf.tensor(FREAKPOINTS);
	this.tensorCaches._computeExtremaFreak = {
	  freakPointsT: tf.keep(freakPoints),
	};
      });
    }
    const {freakPointsT} = this.tensorCaches._computeExtremaFreak;

    const gaussianImagesT = [];
    for (let i = 1; i < pyramidImagesT.length; i++) {
      //gaussianImagesT.push(pyramidImagesT[i][0]);
      gaussianImagesT.push(pyramidImagesT[i][1]); // better
    }

    if (!this.kernelCaches._computeExtremaFreak) {
      const imageVariableNames = [];
      for (let i = 0; i < gaussianImagesT.length; i++) {
	imageVariableNames.push('image' + i);
      }

      let pixelsSubCodes = `float getPixel(int gaussianIndex, int y, int x) {`;
      for (let i = 0; i < gaussianImagesT.length; i++) {
	pixelsSubCodes += `
	  if (gaussianIndex == ${i}) {
	    return getImage${i}(y, x);
	  }
	`
      }
      pixelsSubCodes += `}`;

      const kernel = {
	variableNames: [...imageVariableNames, 'extrema', 'angles', 'freakPoints'],
	outputShape: [prunedExtremas.shape[0], FREAKPOINTS.length],
	userCode: `
	  ${pixelsSubCodes}
	  void main() {
	    ivec2 coords = getOutputCoords();
	    int featureIndex = coords[0];
	    int freakIndex = coords[1];

	    float freakSigma = getFreakPoints(freakIndex, 0);
	    float freakX = getFreakPoints(freakIndex, 1);
	    float freakY = getFreakPoints(freakIndex, 2);

	    int gaussianIndex = int(getExtrema(featureIndex, 1));
	    float inputY = getExtrema(featureIndex, 2);
	    float inputX = getExtrema(featureIndex, 3);
	    float inputAngle = getAngles(featureIndex);
            float cos = ${FREAK_EXPANSION_FACTOR}. * cos(inputAngle);
            float sin = ${FREAK_EXPANSION_FACTOR}. * sin(inputAngle);

	    float yp = inputY + freakX * sin + freakY * cos;
	    float xp = inputX + freakX * cos + freakY * -sin;

	    int x0 = int(floor(xp));
	    int x1 = x0 + 1;
	    int y0 = int(floor(yp));
	    int y1 = y0 + 1;

	    float f1 = getPixel(gaussianIndex, y0, x0);
	    float f2 = getPixel(gaussianIndex, y0, x1);
	    float f3 = getPixel(gaussianIndex, y1, x0);
	    float f4 = getPixel(gaussianIndex, y1, x1);

	    float x1f = float(x1);
	    float y1f = float(y1);
	    float x0f = float(x0);
	    float y0f = float(y0);

	    // ratio for interpolation between four neighbouring points
	    float value = (x1f - xp) * (y1f - yp) * f1
			+ (xp - x0f) * (y1f - yp) * f2
			+ (x1f - xp) * (yp - y0f) * f3
			+ (xp - x0f) * (yp - y0f) * f4;

	    setOutput(value);
	  }
	`
      }

      this.kernelCaches._computeExtremaFreak = [kernel];
    }

    return tf.tidy(() => {
      const [program] = this.kernelCaches._computeExtremaFreak;
      const result = this._compileAndRun(program, [...gaussianImagesT, prunedExtremas, prunedExtremasAngles, freakPointsT]);
      return result;
    });
  }

  _computeExtremaAngles(histograms) {
    if (!this.kernelCaches.computeExtremaAngles) {
      const kernel = {
	variableNames: ['histogram'],
	outputShape: [histograms.shape[0]],
	userCode: `
	  void main() {
	    int featureIndex = getOutputCoords();

	    int maxIndex = 0;
	    for (int i = 1; i < ${ORIENTATION_NUM_BINS}; i++) {
	      if (getHistogram(featureIndex, i) > getHistogram(featureIndex, maxIndex)) {
		maxIndex = i;
	      }
	    }

	    int prev = imod(maxIndex - 1 + ${ORIENTATION_NUM_BINS}, ${ORIENTATION_NUM_BINS});
	    int next = imod(maxIndex + 1, ${ORIENTATION_NUM_BINS});

	    /**
	     * Fit a quatratic to 3 points. The system of equations is:
	     *
	     * y0 = A*x0^2 + B*x0 + C
	     * y1 = A*x1^2 + B*x1 + C
	     * y2 = A*x2^2 + B*x2 + C
	     *
	     * This system of equations is solved for A,B,C.
	     */
	    float p10 = float(maxIndex - 1);
	    float p11 = getHistogram(featureIndex, prev); 
	    float p20 = float(maxIndex);
	    float p21 = getHistogram(featureIndex, maxIndex); 
	    float p30 = float(maxIndex + 1);
	    float p31 = getHistogram(featureIndex, next); 

	    float d1 = (p30-p20)*(p30-p10);
	    float d2 = (p10-p20)*(p30-p10);
	    float d3 = p10-p20;

	    // If any of the denominators are zero then, just use maxIndex.
            float fbin = float(maxIndex);
	    if ( abs(d1) > 0.00001 && abs(d2) > 0.00001 && abs(d3) > 0.00001) {
	      float a = p10*p10;
	      float b = p20*p20;

	      // Solve for the coefficients A,B,C
	      float A = ((p31-p21)/d1)-((p11-p21)/d2);
	      float B = ((p11-p21)+(A*(b-a)))/d3;
	      float C = p11-(A*a)-(B*p10);
	      fbin = -B / (2. * A);
	    }

	    /*
	    float an =  2.0 * ${Math.PI} * ((fbin + 0.5 + ${ORIENTATION_NUM_BINS}.) / ${ORIENTATION_NUM_BINS}.);

	    for (int i = 0; i < 3; i++) { // stupid modula, while loop not support
	      if (an > 2.0 * ${Math.PI}) {
		an -= 2.0 * ${Math.PI};
	      }
	    }
	    */
	    float an = 2.0 *${Math.PI} * (fbin + 0.5) / ${ORIENTATION_NUM_BINS}. - ${Math.PI};
	    setOutput(an);
	  }
	`
      }
      this.kernelCaches.computeExtremaAngles = kernel;
    }
    return tf.tidy(() => {
      const program = this.kernelCaches.computeExtremaAngles; 
      return this._compileAndRun(program, [histograms]);
    });
  }

  // TODO: try just using average momentum for orientation, instead of histogram method
  _computeOrientationHistograms(prunedExtremasT, pyramidImagesT) {
    const nBuckets = NUM_BUCKETS_PER_DIMENSION * NUM_BUCKETS_PER_DIMENSION;
    const regionExpansionFactor = ORIENTATION_REGION_EXPANSION_FACTOR;
    const gaussianExpansionFactor = ORIENTATION_GAUSSIAN_EXPANSION_FACTOR;
    const oneOver2PI = 0.159154943091895;

    const gaussianImagesT = [];
    for (let i = 1; i < pyramidImagesT.length; i++) {
      gaussianImagesT.push(pyramidImagesT[i][1]);
    }

    if (!this.tensorCaches.orientationHistograms) {
      tf.tidy(() => {
        const sigma = 1; // because scale always 0, as dogIndex % 2 === 0. if not true, then it needs to be fixed
        const gwSigma = Math.max(1.0, gaussianExpansionFactor * sigma);
        const gwScale = -1.0 / (2 * gwSigma * gwSigma);
        //const radius = regionExpansionFactor * gwSigma;
        const radius = ORIENTATION_EXPANSION_FACTOR;
        const radiusCeil = Math.ceil(radius);
	//const radiusCeil = 1;

	const radialProperties = [];
        for (let y = -radiusCeil; y <= radiusCeil; y++) {
          for (let x = -radiusCeil; x <= radiusCeil; x++) {
	    const distanceSquare = x * x + y * y;

            if (distanceSquare <= radius * radius) {
	      const _x = distanceSquare * gwScale; 
	      // fast expontenial approx
	      let w = (720+_x*(720+_x*(360+_x*(120+_x*(30+_x*(6+_x))))))*0.0013888888;

	      //if (distanceSquare > 0) w = 0;
	      //else w = 1;

	      radialProperties.push([y, x, w]);
            }
          }
        }
	const imageSizes = [];
	for (let i = 0; i < gaussianImagesT.length; i++) {
	  imageSizes.push([gaussianImagesT[i].shape[0], gaussianImagesT[i].shape[1]]);
	}

        this.tensorCaches.orientationHistograms = {
          radialPropertiesT: tf.keep(tf.tensor(radialProperties, [radialProperties.length, 3])),
	  imageSizesT: tf.keep(tf.tensor(imageSizes, [imageSizes.length, 2]))
        }
      });
    }
    const {radialPropertiesT, imageSizesT} = this.tensorCaches.orientationHistograms;

    if (!this.kernelCaches.computeOrientationHistograms) {
      const imageVariableNames = [];
      for (let i = 0; i < gaussianImagesT.length; i++) {
	imageVariableNames.push('image' + i);
      }

      let kernel1SubCodes = `float getPixel(int gaussianIndex, int y, int x) {`;
      for (let i = 0; i < gaussianImagesT.length; i++) {
	kernel1SubCodes += `
	  if (gaussianIndex == ${i}) {
	    return getImage${i}(y, x);
	  }
	`
      }
      kernel1SubCodes += `}`;

      const kernel1 = {
	variableNames: [...imageVariableNames, 'imageSizes', 'extrema', 'radial'],
	outputShape: [prunedExtremasT.shape[0], radialPropertiesT.shape[0], 2], // last dimension: [fbin, magnitude]
	userCode: `
	  ${kernel1SubCodes}

	  void main() {
	    ivec3 coords = getOutputCoords();
	    int featureIndex = coords[0];
	    int radialIndex = coords[1];
	    int propertyIndex = coords[2];

	    int radialY = int(getRadial(radialIndex, 0));
	    int radialX = int(getRadial(radialIndex, 1));
	    float radialW = getRadial(radialIndex, 2);

	    int extremaIndex = int(getExtrema(featureIndex, 1));
	    int y = int(getExtrema(featureIndex, 2));
	    int x = int(getExtrema(featureIndex, 3));

	    int imageHeight = int(getImageSizes(extremaIndex, 0));
	    int imageWidth = int(getImageSizes(extremaIndex, 1));

	    int xp = x + radialX;
	    int yp = y + radialY;

	    if (xp < 1 || xp >= imageWidth - 1 || yp < 1 || yp >= imageHeight - 1) {
	      setOutput(0.);
	      return;
	    }

	    float dy = getPixel(extremaIndex, yp+1, xp) - getPixel(extremaIndex, yp-1, xp);
	    float dx = getPixel(extremaIndex, yp, xp+1) - getPixel(extremaIndex, yp, xp-1);

	    if (propertyIndex == 0) {
	      // be careful that atan(0, 0) gives 1.57 instead of 0 (different from js), but doesn't matter here, coz magnitude is 0
	      
	      float angle = atan(dy, dx) + ${Math.PI};
	      float fbin = angle * ${ORIENTATION_NUM_BINS}. * ${oneOver2PI};
	      setOutput(fbin);
	      return;
	    }

	    if (propertyIndex == 1) {
	      float mag = sqrt(dx * dx + dy * dy);
	      float magnitude = radialW * mag;
	      setOutput(magnitude);
	      return;
	    }
	  }

	`
      }

      const kernel2 = {
	variableNames: ['fbinMag'],
	outputShape: [prunedExtremasT.shape[0], ORIENTATION_NUM_BINS],
	userCode: `
	  void main() {
	    ivec2 coords = getOutputCoords();
	    int featureIndex = coords[0];
	    int binIndex = coords[1];

	    float sum = 0.;
	    for (int i = 0; i < ${radialPropertiesT.shape[0]}; i++) {
	      float fbin = getFbinMag(featureIndex, i, 0);
	      int bin = int(floor(fbin - 0.5));
	      int b1 = imod(bin + ${ORIENTATION_NUM_BINS}, ${ORIENTATION_NUM_BINS});
	      int b2 = imod(bin + 1 + ${ORIENTATION_NUM_BINS}, ${ORIENTATION_NUM_BINS});

	      if (b1 == binIndex || b2 == binIndex) {
		float magnitude = getFbinMag(featureIndex, i, 1);
		float w2 = fbin - float(bin) - 0.5;
		float w1 = w2 * -1. + 1.;

		if (b1 == binIndex) {
		  sum += w1 * magnitude;
		}
		if (b2 == binIndex) {
		  sum += w2 * magnitude;
		}
	      }
	    }
	    setOutput(sum);
	  }
	`
      }

      this.kernelCaches.computeOrientationHistograms = [kernel1, kernel2];
    }

    return tf.tidy(() => {
      const [program1, program2] = this.kernelCaches.computeOrientationHistograms;
      const result1 = this._compileAndRun(program1, [...gaussianImagesT, imageSizesT, prunedExtremasT, radialPropertiesT]);
      const result2 = this._compileAndRun(program2, [result1]);
      return result2;
    });
  }

  // The histogram is smoothed with a Gaussian, with sigma = 1
  _smoothHistograms(histograms) {
    if (!this.kernelCaches.smoothHistograms) {
      const kernel = {
	variableNames: ['histogram'],
	outputShape: [histograms.shape[0], ORIENTATION_NUM_BINS],
	userCode: `
	  void main() {
	    ivec2 coords = getOutputCoords();

	    int featureIndex = coords[0];
	    int binIndex = coords[1];

	    int prevBin = imod(binIndex - 1 + ${ORIENTATION_NUM_BINS}, ${ORIENTATION_NUM_BINS});
	    int nextBin = imod(binIndex + 1, ${ORIENTATION_NUM_BINS});

            float result = 0.274068619061197 * getHistogram(featureIndex, prevBin) + 0.451862761877606 * getHistogram(featureIndex, binIndex) + 0.274068619061197 * getHistogram(featureIndex, nextBin);

	    setOutput(result);
	  }
	`
      }
      this.kernelCaches.smoothHistograms = kernel;
    }
    return tf.tidy(() => {
      const program = this.kernelCaches.smoothHistograms; 
      for (let i = 0; i < ORIENTATION_SMOOTHING_ITERATIONS; i++) {
	histograms = this._compileAndRun(program, [histograms]);
      }
      return histograms;
    });
  }

  _computeLocalization(prunedExtremasList, dogPyramidImagesT) {
    if (!this.kernelCaches.computeLocalization) {
      const dogVariableNames = [];

      let dogSubCodes = `float getPixel(int k, int y, int x) {`;
      for (let i = 1; i < dogPyramidImagesT.length; i++) {
	dogVariableNames.push('image' + i);
	dogSubCodes += `
	  if (k == ${i}) {
	    return getImage${i}(y, x);
	  }
 	`;
      }
      dogSubCodes += `}`;

      const kernel = {
	variableNames: [...dogVariableNames, 'extrema'],
	outputShape: [prunedExtremasList.length, 3, 3], // 3x3 pixels around the extrema
	userCode: `
	  ${dogSubCodes}

	  void main() {
	    ivec3 coords = getOutputCoords();
	    int featureIndex = coords[0];
	    int dy = coords[1]-1;
	    int dx = coords[2]-1;
	    int k = int(getExtrema(featureIndex, 1)) + 1;
	    int y = int(getExtrema(featureIndex, 2));
	    int x = int(getExtrema(featureIndex, 3));
	    setOutput(getPixel(k, y+dy, x+dx));
	  }
	`
      }

      this.kernelCaches.computeLocalization = [kernel];
    }

    return tf.tidy(() => {
      const program = this.kernelCaches.computeLocalization[0];
      const prunedExtremasT = tf.tensor(prunedExtremasList, [prunedExtremasList.length, prunedExtremasList[0].length], 'int32');

      //const pixelsT = this._compileAndRun(program, [...dogPyramidImagesT.slice(1,-1), prunedExtremasT]);
      const pixelsT = this._compileAndRun(program, [...dogPyramidImagesT.slice(1), prunedExtremasT]);
      const pixels = pixelsT.arraySync();

      const result = [];
      for (let i = 0; i < pixels.length; i++) {
	result.push([]);
	for (let j = 0; j < pixels[i].length; j++) {
	  result[i].push([]);
	}
      }

      const localizedExtremas = [];
      for (let i = 0; i < prunedExtremasList.length; i++) {
	localizedExtremas[i] = [
	  prunedExtremasList[i][0],
	  prunedExtremasList[i][1],
	  prunedExtremasList[i][2],
	  prunedExtremasList[i][3],
	];
      }

      for (let i = 0; i < localizedExtremas.length; i++) {
	if (localizedExtremas[i][0] === 0) {
	  continue;
	}
	const pixel = pixels[i];
	const dx = 0.5 * (pixel[1][2] - pixel[1][0]);
	const dy = 0.5 * (pixel[2][1] - pixel[0][1]);
	const dxx = pixel[1][2] + pixel[1][0] - 2 * pixel[1][1];
	const dyy = pixel[2][1] + pixel[0][1] - 2 * pixel[1][1];
	const dxy = 0.25 * (pixel[0][0] + pixel[2][2] - pixel[0][2] - pixel[2][0]);

	const det = dxx * dyy - dxy * dxy;
	const ux = (dyy * -dx + -dxy * -dy) / det;
	const uy = (-dxy * -dx + dxx * -dy) / det;

	const newY = localizedExtremas[i][2] + uy;
	const newX = localizedExtremas[i][3] + ux;

	if (Math.abs(det) < 0.0001) {
	  continue;
	}

	localizedExtremas[i][2] = newY;
	localizedExtremas[i][3] = newX;
	//localizedExtremas[i][2] = Math.round(newY);
	//localizedExtremas[i][3] = Math.round(newX);
      }
      return tf.tensor(localizedExtremas, [localizedExtremas.length, localizedExtremas[0].length], 'float32');
    });
  }

  // faster to do it in CPU
  // if we do in gpu, we probably need to use tf.topk(), which seems to be run in CPU anyway (no gpu operation for that)
  //  TODO: research adapative maximum supression method
  _applyPrune(extremasResultsT) {
    const nBuckets = NUM_BUCKETS_PER_DIMENSION * NUM_BUCKETS_PER_DIMENSION;
    const nFeatures = MAX_FEATURES_PER_BUCKET;

    // combine results into a tensor of:
    //   nBuckets x nFeatures x [score, extremaIndex, y, x]
    const curAbsScores = [];
    const result = [];
    for (let i = 0; i < nBuckets; i++) {
      result.push([]);
      curAbsScores.push([]);
      for (let j = 0; j < nFeatures; j++) {
	result[i].push([0,0,0,0]);
	curAbsScores[i].push(0);
      }
    }

    for (let k = 0; k < extremasResultsT.length; k++) {
      const extremaScoresT = extremasResultsT[k];
      const extremaScores = extremaScoresT.arraySync();

      const height = extremaScoresT.shape[0];
      const width = extremaScoresT.shape[1];

      const bucketWidth = width / NUM_BUCKETS_PER_DIMENSION;
      const bucketHeight = height / NUM_BUCKETS_PER_DIMENSION;

      for (let j = 0; j < height; j++) {
	for (let i = 0; i < width; i++) {
	  const bucketX = Math.floor(i / bucketWidth);
	  const bucketY = Math.floor(j / bucketHeight);
	  const bucket = bucketY * NUM_BUCKETS_PER_DIMENSION + bucketX;

	  const score = extremaScores[j][i];
	  const absScore = Math.abs(score);

	  let tIndex = nFeatures;
	  while (tIndex >= 1 && absScore > curAbsScores[bucket][tIndex-1]) {
	    tIndex -= 1;
	  }

	  if (tIndex < nFeatures) {
	    for (let t = nFeatures - 1; t >= tIndex+1; t--) {
	      curAbsScores[bucket][t] = curAbsScores[bucket][t-1];
	      result[bucket][t][0] = result[bucket][t-1][0];
	      result[bucket][t][1] = result[bucket][t-1][1];
	      result[bucket][t][2] = result[bucket][t-1][2];
	      result[bucket][t][3] = result[bucket][t-1][3];
	    }
	    curAbsScores[bucket][tIndex] = absScore;
	    result[bucket][tIndex][0] = score;
	    result[bucket][tIndex][1] = k; 
	    result[bucket][tIndex][2] = j; 
	    result[bucket][tIndex][3] = i; 
	  }
	}
      }
    }

    // combine all buckets into a single list
    const list = [];
    for (let i = 0; i < nBuckets; i++) {
      for (let j = 0; j < nFeatures; j++) {
	list.push(result[i][j]);
      }
    }
    //console.log("result", result);
    //console.log("list", list);
    return list;

    return tf.tensor(result, [result.length, result[0].length, result[0][0].length], 'int32');
  }

  _buildExtremas(dogIndex, image0, image1, image2) {
    const imageHeight = image1.shape[0];
    const imageWidth = image1.shape[1];

    const kernelKey = 'w' + imageWidth;

    if (!this.kernelCaches.buildExtremas) {
      this.kernelCaches.buildExtremas = {};
    }
    if (!this.kernelCaches.buildExtremas[kernelKey]) {
      const kernel = {
	variableNames: ['image0', 'image1', 'image2'],
	outputShape: [imageHeight, imageWidth],
	userCode: `
	  void main() {
	    ivec2 coords = getOutputCoords();

	    int y = coords[0];
	    int x = coords[1];

	    // Step 1: find local maxima/minima
	    if (getImage1(y, x) * getImage1(y, x) < ${LAPLACIAN_SQR_THRESHOLD}.) {
	      setOutput(0.);
	      return;
	    }
	    if (y < ${FREAK_EXPANSION_FACTOR} || y > ${imageHeight - 1 - FREAK_EXPANSION_FACTOR}) {
	      setOutput(0.);
	      return;
	    }
	    if (x < ${FREAK_EXPANSION_FACTOR} || x > ${imageWidth - 1 - FREAK_EXPANSION_FACTOR}) {
	      setOutput(0.);
	      return;
	    }

	    bool isMax = true;
	    for (int dy = -1; dy <= 1; dy++) {
	      for (int dx = -1; dx <= 1; dx++) {
	        if (getImage1(y, x) < getImage0(y+dy, x+dx)) {
		  isMax = false;
		}
	        if (getImage1(y, x) < getImage2(y+dy, x+dx)) {
		  //isMax = false;
		}
	        if (getImage1(y, x) < getImage1(y+dy, x+dx)) {
		  isMax = false;
		}
	      }
	    }
	    bool isMin = false;
	    if (!isMax) {
	      isMin = true;

	      for (int dy = -1; dy <= 1; dy++) {
		for (int dx = -1; dx <= 1; dx++) {
		  if (getImage1(y, x) > getImage0(y+dy, x+dx)) {
		    isMin = false;
		  }
		  if (getImage1(y, x) > getImage2(y+dy, x+dx)) {
		    //isMin = false;
		  }
		  if (getImage1(y, x) > getImage1(y+dy, x+dx)) {
		    isMin = false;
		  }
		}
	      }
	    }

	    if (!isMax && !isMin) {
	      setOutput(0.);
	      return;
	    }

	    // Compute spatial derivatives
	    float dx = 0.5 * (getImage1(y, x+1) - getImage1(y, x-1));
	    float dy = 0.5 * (getImage1(y+1, x) - getImage1(y-1, x));
	    float dxx = getImage1(y, x+1) + getImage1(y, x-1) - 2. * getImage1(y, x);
	    float dyy = getImage1(y+1, x) + getImage1(y-1, x) - 2. * getImage1(y, x);
	    float dxy = 0.25 * (getImage1(y-1,x-1) + getImage1(y+1,x+1) - getImage1(y-1,x+1) - getImage1(y+1,x-1));

	    // compute edge score
	    float det = (dxx * dyy) - (dxy * dxy);

	    if (abs(det) < 0.0001) { // determinant undefined. no solution
	      setOutput(0.);
	      return;
	    }

	    float edgeScore = (dxx + dyy) * (dxx + dyy) / det;

	    if (abs(edgeScore) >= ${EDGE_HESSIAN_THRESHOLD} ) {
	      setOutput(0.);
	      return;
	    }
	    setOutput(getImage1(y,x));
	  }
	`
      };
      this.kernelCaches.buildExtremas[kernelKey] = kernel;
    }

    return tf.tidy(() => {
      const program = this.kernelCaches.buildExtremas[kernelKey];
      image0 = this._downsampleBilinear(image0);
      return this._compileAndRun(program, [image0, image1, image2]);
      //return this._runWebGLProgram(program, [image0, image1, image2], 'float32');
    });
  }

  _differenceImageBinomial(image1, image2) {
    return tf.tidy(() => {
      return image1.sub(image2);
    });
  }

  // 4th order binomail filter [1,4,6,4,1] X [1,4,6,4,1]
  _applyFilter(image) {
    const imageHeight = image.shape[0];
    const imageWidth = image.shape[1];

    const kernelKey = 'w' + imageWidth;
    if (!this.kernelCaches.applyFilter) {
      this.kernelCaches.applyFilter = {};
    }

    if (!this.kernelCaches.applyFilter[kernelKey]) {
      const imaxmin = `
	int imax(int a, int b) {
	  if (a > b) return a;
	  return b;
	}
	int imin(int a, int b) {
	  if (a < b) return a;
	  return b;
	}

      `
      const kernel1 = {
	variableNames: ['p'],
	outputShape: [imageHeight, imageWidth],
	userCode: `
 	  ${imaxmin}
	  void main() {
	    ivec2 coords = getOutputCoords();

	    float sum = getP(coords[0], imax(0, coords[1]-2));
	    sum += getP(coords[0], imax(0, coords[1]-1)) * 4.;
	    sum += getP(coords[0], coords[1]) * 6.;
	    sum += getP(coords[0], imin(${imageWidth}-1, coords[1]+1)) * 4.;
	    sum += getP(coords[0], imin(${imageWidth}-1, coords[1]+2));
	    setOutput(sum);
	  }
	`
      };

      const kernel2 = {
	variableNames: ['p'],
	outputShape: [imageHeight, imageWidth],
	userCode: `
 	  ${imaxmin}
	  void main() {
	    ivec2 coords = getOutputCoords();

	    float sum = getP(imax(coords[0]-2, 0), coords[1]);
	    sum += getP(imax(coords[0]-1, 0), coords[1]) * 4.;
	    sum += getP(coords[0], coords[1]) * 6.;
	    sum += getP(imin(coords[0]+1, ${imageHeight}-1), coords[1]) * 4.;
	    sum += getP(imin(coords[0]+2, ${imageHeight}-1), coords[1]);
	    sum /= 256.;
	    setOutput(sum);
	  }
	`
      };
      this.kernelCaches.applyFilter[kernelKey] = [kernel1, kernel2];
    }

    return tf.tidy(() => {
      const [program1, program2] = this.kernelCaches.applyFilter[kernelKey];

      const result1 = this._compileAndRun(program1, [image]);
      const result2 = this._compileAndRun(program2, [result1]);
      return result2;
    });
  }

  _downsampleBilinear(image) {
    const imageHeight = image.shape[0];
    const imageWidth = image.shape[1];

    const kernelKey = 'w' + imageWidth;
    if (!this.kernelCaches.downsampleBilinear) {
      this.kernelCaches.downsampleBilinear = {};
    }

    if (!this.kernelCaches.downsampleBilinear[kernelKey]) {
      const kernel = {
	variableNames: ['p'],
	outputShape: [Math.floor(imageHeight/2), Math.floor(imageWidth/2)],
	userCode: `
	  void main() {
	    ivec2 coords = getOutputCoords();
	    int y = coords[0] * 2;
	    int x = coords[1] * 2;

	    float sum = getP(y, x) * 0.25;
	    sum += getP(y+1,x) * 0.25; 
	    sum += getP(y, x+1) * 0.25; 
	    sum += getP(y+1,x+1) * 0.25;
	    setOutput(sum);
	  }
	`
      };
      this.kernelCaches.downsampleBilinear[kernelKey] = kernel;
    }

    return tf.tidy(() => {
      const program = this.kernelCaches.downsampleBilinear[kernelKey];
      return this._compileAndRun(program, [image]);
    });
  }

  _upsampleBilinear(image) {
    const imageHeight = image.shape[0];
    const imageWidth = image.shape[1];

    const kernelKey = 'w' + imageWidth;
    if (!this.kernelCaches.upsampleBilinear) {
      this.kernelCaches.upsampleBilinear = {};
    }

    if (!this.kernelCaches.upsampleBilinear[kernelKey]) {
      const kernel = {
	variableNames: ['p'],
	outputShape: [imageHeight*2, imageWidth*2],
	userCode: `
	  void main() {
	    ivec2 coords = getOutputCoords();
	    int y = coords[0] / 2;
	    int x = coords[1] / 2;

	    float sum = getP(y, x) * 0.25;
	    sum += getP(y+1,x) * 0.25; 
	    sum += getP(y, x+1) * 0.25; 
	    sum += getP(y+1,x+1) * 0.25;
	    setOutput(sum);
	  }
	`
      };
      this.kernelCaches.upsampleBilinear[kernelKey] = kernel;
    }

    return tf.tidy(() => {
      const program = this.kernelCaches.downsampleBilinear[kernelKey];
      return this._compileAndRun(program, [image]);
    });
  }

  _compileAndRun(program, inputs) {
    const outInfo = tf.backend().compileAndRun(program, inputs);
    return tf.engine().makeTensorFromDataId(outInfo.dataId, outInfo.shape, outInfo.dtype);
  }

  _runWebGLProgram(program, inputs, outputType) {
    const outInfo = tf.backend().runWebGLProgram(program, inputs, outputType);
    return tf.engine().makeTensorFromDataId(outInfo.dataId, outInfo.shape, outInfo.dtype);
  }
}

module.exports = {
  Detector
};





