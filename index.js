// my personal token - please generate your own at https://www.mapbox.com/studio/
mapboxgl.accessToken = 'pk.eyJ1IjoicnVra3UiLCJhIjoiZEJocE9tSSJ9.tWSIxlu5AHgccim4JMuWLQ';

// initialize a Mapbox map with the Basic style, centered in New York
var map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/navigation-day-v1',
    center: [121.0437, 14.6760],
    zoom: 11,
    hash: true
});

var h = 300; // size of the chart canvas
var r = h / 2; // radius of the polar histogram
var numBins = 64; // number of orientation bins spread around 360 deg.

var canvas = document.getElementById('canvas');
var ctx = canvas.getContext('2d');

canvas.style.width = canvas.style.height = h + 'px';
canvas.width = canvas.height = h;

if (window.devicePixelRatio > 1) {
    canvas.width = canvas.height = h * 2;
    ctx.scale(2, 2);
}

var roadLayers = []; // style layer IDs that render from the 'road' source-layer
var lguIndex = [];   // [{bbox: [w,s,e,n], feature}, ...] — built on dataset load

var currentBoundary = null; // GeoJSON Feature<Polygon|MultiPolygon>
var currentBoundaryName = '';

function pointInPolygon(point, feature) {
    var polys = feature.geometry.type === 'Polygon'
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates;
    var x = point[0], y = point[1];
    for (var p = 0; p < polys.length; p++) {
        var inside = false;
        var rings = polys[p];
        for (var ri = 0; ri < rings.length; ri++) {
            var ring = rings[ri];
            for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                if (((ring[i][1] > y) !== (ring[j][1] > y)) &&
                    x < (ring[j][0] - ring[i][0]) * (y - ring[i][1]) / (ring[j][1] - ring[i][1]) + ring[i][0]) {
                    inside = !inside;
                }
            }
        }
        if (inside) return true;
    }
    return false;
}

function isCenterInCurrentBoundary() {
    if (!currentBoundary) return false;
    var c = map.getCenter();
    return pointInPolygon([c.lng, c.lat], currentBoundary);
}

function computeBBox(feature) {
    var coords = feature.geometry.type === 'Polygon'
        ? feature.geometry.coordinates.flat(1)
        : feature.geometry.coordinates.flat(2);
    var w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (var i = 0; i < coords.length; i++) {
        if (coords[i][0] < w) w = coords[i][0];
        if (coords[i][1] < s) s = coords[i][1];
        if (coords[i][0] > e) e = coords[i][0];
        if (coords[i][1] > n) n = coords[i][1];
    }
    return [w, s, e, n];
}

function findLGU(lng, lat) {
    for (var i = 0; i < lguIndex.length; i++) {
        var b = lguIndex[i].bbox;
        if (lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3]) {
            if (pointInPolygon([lng, lat], lguIndex[i].feature)) {
                return lguIndex[i].feature;
            }
        }
    }
    return null;
}

function updateCurrentBoundary() {
    var c = map.getCenter();
    var found = findLGU(c.lng, c.lat);
    currentBoundary = found || null;
    currentBoundaryName = found ? (found.properties.shapeName || '') : '';
    updateBoundaryLayer();
}

function updateBoundaryLayer() {
    var src = map.getSource('boundary');
    if (src) src.setData(currentBoundary || { type: 'FeatureCollection', features: [] });
    document.getElementById('boundary-name').textContent = currentBoundaryName;
}

function updateOrientations() {
    ctx.clearRect(0, 0, h, h);

    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath();
    ctx.arc(r, r, r, 0, 2 * Math.PI, false);
    ctx.fill();

    var features = map.queryRenderedFeatures({layers: roadLayers});
    if (features.length === 0) return;

    var ruler = cheapRuler(map.getCenter().lat);
    var bounds = map.getBounds();
    var bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
    var bearing = map.getBearing();
    var bins = new Float64Array(numBins);

    for (var i = 0; i < features.length; i++) {
        var geom = features[i].geometry;
        if (!geom || (geom.type !== 'LineString' && geom.type !== 'MultiLineString')) continue;
        var lines = geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;

        var clippedLines = [];
        if (currentBoundary) {
            for (var j = 0; j < lines.length; j++) {
                var coords = lines[j].filter(Boolean), segment = [];
                for (var k = 0; k < coords.length; k++) {
                    if (pointInPolygon(coords[k], currentBoundary)) {
                        segment.push(coords[k]);
                    } else {
                        if (segment.length > 1) clippedLines.push(segment);
                        segment = [];
                    }
                }
                if (segment.length > 1) clippedLines.push(segment);
            }
        } else {
            for (var j = 0; j < lines.length; j++) {
                var coords = lines[j].filter(Boolean);
                if (coords.length > 1) {
                    clippedLines.push.apply(clippedLines, lineclip(coords, bbox));
                }
            }
        }

        for (var l = 0; l < clippedLines.length; l++) {
            analyzeLine(bins, ruler, clippedLines[l], features[i].properties.oneway !== 'true');
        }
    }

    var binMax = Math.max.apply(null, bins);

    for (i = 0; i < numBins; i++) {
        var a0 = ((i - 0.5) * 360 / numBins - 90 - bearing) * Math.PI / 180;
        var a1 = ((i + 0.5) * 360 / numBins - 90 - bearing) * Math.PI / 180;
        ctx.fillStyle = interpolateSinebow((2 * i % numBins) / numBins);
        ctx.beginPath();
        ctx.moveTo(r, r);
        ctx.arc(r, r, r * Math.sqrt(bins[i] / binMax), a0, a1, false);
        ctx.closePath();
        ctx.fill();
    }
}

function analyzeLine(bins, ruler, line, isTwoWay) {
    for (var i = 0; i < line.length - 1; i++) {
        var bearing = ruler.bearing(line[i], line[i + 1]);
        var distance = ruler.distance(line[i], line[i + 1]);

        var k0 = Math.round((bearing + 360) * numBins / 360) % numBins; // main bin
        var k1 = Math.round((bearing + 180) * numBins / 360) % numBins; // opposite bin

        bins[k0] += distance;
        if (isTwoWay) bins[k1] += distance;
    }
}

// rainbow colors for the chart http://basecase.org/env/on-rainbows
function interpolateSinebow(t) {
    t = 0.5 - t;
    var r = Math.floor(250 * Math.pow(Math.sin(Math.PI * (t + 0 / 3)), 2));
    var g = Math.floor(250 * Math.pow(Math.sin(Math.PI * (t + 1 / 3)), 2));
    var b = Math.floor(250 * Math.pow(Math.sin(Math.PI * (t + 2 / 3)), 2));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
}

map.on('load', function () {
    roadLayers = map.getStyle().layers
        .filter(function(l) { return l['source-layer'] === 'road'; })
        .map(function(l) { return l.id; });

    map.addSource('boundary', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
        id: 'boundary-line',
        type: 'line',
        source: 'boundary',
        layout: {
            'line-join': 'round',
            'line-cap': 'round'
        },
        paint: {
            'line-color': '#ff0000',
            'line-width': 4,
            'line-opacity': 0.8
        }
    });

    updateOrientations(); // immediate render, no boundary yet

    fetch('geoBoundaries-PHL-ADM3_simplified.geojson')
        .then(function(res) { return res.json(); })
        .then(function(data) {
            lguIndex = data.features.map(function(f) {
                return { bbox: computeBBox(f), feature: f };
            });
            updateCurrentBoundary();
            updateOrientations();
        });

    // update the chart on moveend; we could do that on move,
    // but this is slow on some zoom levels due to a huge amount of roads
    map.on('moveend', function () {
        if (!isCenterInCurrentBoundary()) {
            updateCurrentBoundary();
        }
        updateOrientations();
    });
});
