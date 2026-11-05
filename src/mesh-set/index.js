import {AdditiveBlending, BoxGeometry, CustomBlending, MaxEquation, Mesh, MeshLambertMaterial, MultiplyBlending, OneFactor, ShaderMaterial, SphereGeometry, Vector3} from 'three';
import {blink} from '../helpers/helpers';
import AircraftGeometry from './aircraft-geometry.js';
import CarGeometry from './car-geometry.js';
import InstancedGeometry from './instanced-geometry.js';
import commonVertexShaderChunk from './common-vertex.glsl';
import colorVertexShaderChunk from './color-vertex.glsl';
import beginnormalVertexShaderChunk from './beginnormal-vertex.glsl';
import beginVertexShaderChunk from './begin-vertex.glsl';
import projectVertexShaderChunk from './project-vertex.glsl';
import commonFragmentShaderChunk from './common-fragment.glsl';
import diffuseColorFragmentShaderChunk from './diffuse-color-fragment.glsl';
import outlineFragmentShader from './outline-fragment.glsl';
import outlineVertexShader from './outline-vertex.glsl';
import pickingFragmentShader from './picking-fragment.glsl';
import pickingVertexShader from './picking-vertex.glsl';
import delayMarkerFragmentShader from './delay-marker-fragment.glsl';
import delayMarkerVertexShader from './delay-marker-vertex.glsl';

export default class {

    constructor(type, count, parameters) {
        const me = this;

        const baseGeometry =
            type === 'CAR' ? new CarGeometry(.88, 1.76, .88) :
            type === 'AIRCRAFT' ? new AircraftGeometry(.88, 2.64, .88, .1) :
            new BoxGeometry(.6, 1.2, .6);

        const uniforms = me.uniforms = {
            zoom: {value: parameters.zoom},
            cameraZ: {value: parameters.cameraZ},
            modelScale: {value: parameters.modelScale},
            textureData0: {value: null},
            textureData1: {value: null},
            textureColor: {value: null}
        };

        const geometry = me.geometry = new InstancedGeometry(baseGeometry, count);
        const material = me.material = new MeshLambertMaterial({
            transparent: true
        });

        material.onBeforeCompile = shader => {
            Object.assign(shader.uniforms, uniforms);
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', commonVertexShaderChunk)
                .replace('#include <color_vertex>', colorVertexShaderChunk)
                .replace('#include <beginnormal_vertex>', beginnormalVertexShaderChunk)
                .replace('#include <begin_vertex>', beginVertexShaderChunk)
                .replace('#include <project_vertex>', projectVertexShaderChunk);
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', commonFragmentShaderChunk)
                .replace('vec4 diffuseColor = vec4( diffuse, opacity );', diffuseColorFragmentShaderChunk);
            shader.defines = {[type]: true};
        };
        material.customProgramCacheKey = () => type;

        const mesh = me.mesh = new Mesh(geometry, material);

        mesh.updateMatrix();
        mesh.matrixAutoUpdate = false;
        mesh.frustumCulled = false;

        const pickingMaterial = me.pickingMaterial = new ShaderMaterial({
            uniforms,
            vertexShader: pickingVertexShader,
            fragmentShader: pickingFragmentShader,
            defines: {[type]: true}
        });

        const pickingMesh = me.pickingMesh = new Mesh(geometry, pickingMaterial);

        pickingMesh.updateMatrix();
        pickingMesh.matrixAutoUpdate = false;
        pickingMesh.frustumCulled = false;

        const outlineGeometry = me.outlineGeometry = new InstancedGeometry(baseGeometry, 2);
        const outlineMaterial = me.outlineMaterial = new ShaderMaterial({
            uniforms: Object.assign({}, uniforms, {
                marked: {value: -1},
                tracked: {value: -1},
                intensity: {value: 0}
            }),
            vertexShader: outlineVertexShader,
            fragmentShader: outlineFragmentShader,
            defines: {[type]: true},
            transparent: true,
            depthTest: false,
            depthWrite: false,
            // MAX blending avoids overlapping outlines compositing to a higher alpha than either alone.
            blending: CustomBlending,
            blendEquation: MaxEquation,
            blendSrc: OneFactor,
            blendDst: OneFactor
        });

        const outlineMesh = me.outlineMesh = new Mesh(outlineGeometry, outlineMaterial);

        outlineMesh.updateMatrix();
        outlineMesh.matrixAutoUpdate = false;
        outlineMesh.frustumCulled = false;

        baseGeometry.dispose();

        // Delay marker spheres: Tokyo trains (CAR) keep a single orange
        // marker; GO vehicles (BUS) get yellow (3-14 min late) and red
        // (15+ min late) markers driven by TripUpdates delay levels.
        // The highlight marker is a larger white shell around the
        // vehicle (same sphere, wider radius) so it reads as a glow
        // ring over the delay sphere instead of covering it.
        const delayMarkerColors = type === 'CAR' ? [
            ['delayMarker', [1.0, 0.6, 0.0], 1.8]
        ] : type === 'BUS' ? [
            ['delayMarkerYellow', [1.0, 0.85, 0.0], 1.8],
            ['delayMarkerRed', [0.95, 0.15, 0.15], 1.8],
            ['highlightMarker', [1.0, 1.0, 1.0], 2.6]
        ] : [];

        for (const [key, color, radius] of delayMarkerColors) {
            const sphereGeometry = new SphereGeometry(radius, 32, 32);
            const geometry = me[`${key}Geometry`] = new InstancedGeometry(sphereGeometry, count);
            const material = me[`${key}Material`] = new ShaderMaterial({
                uniforms: Object.assign({}, uniforms, {
                    base: {value: 1},
                    markerColor: {value: new Vector3(...color)}
                }),
                vertexShader: delayMarkerVertexShader,
                fragmentShader: delayMarkerFragmentShader,
                blending: MultiplyBlending,
                premultipliedAlpha: true,
                depthWrite: false
            });

            const mesh = me[`${key}Mesh`] = new Mesh(geometry, material);

            mesh.updateMatrix();
            mesh.matrixAutoUpdate = false;
            mesh.frustumCulled = false;

            sphereGeometry.dispose();
        }

    }

    getMesh() {
        return this.mesh;
    }

    getPickingMesh() {
        return this.pickingMesh;
    }

    getOutlineMesh() {
        return this.outlineMesh;
    }

    getDelayMarkerMesh() {
        return this.delayMarkerMesh;
    }

    getDelayMarkerYellowMesh() {
        return this.delayMarkerYellowMesh;
    }

    getDelayMarkerRedMesh() {
        return this.delayMarkerRedMesh;
    }

    getHighlightMarkerMesh() {
        return this.highlightMarkerMesh;
    }

    refreshCameraParams(params) {
        const uniforms = this.uniforms;

        uniforms.zoom.value = params.zoom;
        uniforms.cameraZ.value = params.cameraZ;
    }

    setTextures(textures) {
        const me = this,
            uniforms = me.uniforms;

        uniforms.textureData0.value = textures[0];
        uniforms.textureData1.value = textures[1];
        uniforms.textureColor.value = textures[2];

        me.outlineMaterial.uniforms.intensity.value = blink();
    }

    setInstanceIDs(ids) {
        const me = this,
            delayMarkerGeometry = me.delayMarkerGeometry;

        me.geometry.setInstanceIDs(ids.body);
        me.outlineGeometry.setInstanceIDs(ids.outline);
        if (delayMarkerGeometry) {
            delayMarkerGeometry.setInstanceIDs(ids.delayMarker);
        }
        if (me.delayMarkerYellowGeometry) {
            me.delayMarkerYellowGeometry.setInstanceIDs(ids.delayMarkerYellow);
        }
        if (me.delayMarkerRedGeometry) {
            me.delayMarkerRedGeometry.setInstanceIDs(ids.delayMarkerRed);
        }
        if (me.highlightMarkerGeometry) {
            me.highlightMarkerGeometry.setInstanceIDs(ids.highlightMarker);
        }
    }

    setMarkedInstanceID(id) {
        this.outlineMaterial.uniforms.marked.value = id;
    }

    setTrackedInstanceID(id) {
        this.outlineMaterial.uniforms.tracked.value = id;
    }

    refreshDelayMarkerMesh(dark) {
        const {delayMarkerMaterial, delayMarkerMesh} = this;

        if (delayMarkerMaterial) {
            delayMarkerMaterial.uniforms.base.value = dark ? 0 : 1;
        }
        if (delayMarkerMesh) {
            delayMarkerMesh.material.blending = dark ? AdditiveBlending : MultiplyBlending;
        }
        for (const key of ['delayMarkerYellow', 'delayMarkerRed', 'highlightMarker']) {
            const material = this[`${key}Material`],
                mesh = this[`${key}Mesh`];
            if (material) {
                material.uniforms.base.value = dark ? 0 : 1;
            }
            if (mesh) {
                mesh.material.blending = dark ? AdditiveBlending : MultiplyBlending;
            }
        }
    }

    dispose() {
        const me = this,
            {delayMarkerGeometry, delayMarkerMaterial} = me;

        me.geometry.dispose();
        me.material.dispose();
        me.pickingMaterial.dispose();
        me.outlineGeometry.dispose();
        me.outlineMaterial.dispose();
        if (delayMarkerGeometry) {
            delayMarkerGeometry.dispose();
        }
        if (delayMarkerMaterial) {
            delayMarkerMaterial.dispose();
        }
        for (const key of ['delayMarkerYellow', 'delayMarkerRed', 'highlightMarker']) {
            const geometry = me[`${key}Geometry`],
                material = me[`${key}Material`];
            if (geometry) {
                geometry.dispose();
            }
            if (material) {
                material.dispose();
            }
        }
    }

}
