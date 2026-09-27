#!/usr/bin/env python3
"""Trace the supplied MONEY PRINTER OS art into an actual extruded, colored GLB.

Build dependencies: Pillow, numpy, opencv-python-headless, mapbox-earcut.
The result contains indexed triangle meshes, not an image on a rectangular plane.
Run: python scripts/build-logo-model.py
"""

from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import importlib.metadata
import json
import math
import struct
from pathlib import Path

import numpy as np
from PIL import Image

try:
    import cv2
    import mapbox_earcut
except ImportError as exc:
    raise SystemExit("Install build dependencies: pip install opencv-python-headless mapbox-earcut") from exc


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "public/assets/mpo-logo-3d.webp"
DEFAULT_OUTPUT = ROOT / "public/assets/mpo-logo-model.glb"
DEFAULT_MANIFEST = ROOT / "public/assets/mpo-logo-model.manifest.json"
# Image-specific seed points for the actual O/P/R/R/O counters. Specular edge
# highlights close several other dark gaps and must not become holes in the mesh.
COUNTER_SEEDS = ((354, 195), (115, 364), (189, 359), (536, 347), (647, 388))


def signed_area(ring):
    p = np.asarray(ring, dtype=np.float64)
    return float(np.sum(p[:, 0] * np.roll(p[:, 1], -1) - np.roll(p[:, 0], -1) * p[:, 1]) / 2)


def rgb_at(field, x, y):
    """Sample a smooth, source-derived neon face gradient."""
    ix, iy = int(round(x)), int(round(y))
    h, w = field.shape[:2]
    rgb = field[min(h - 1, max(0, iy)), min(w - 1, max(0, ix))]
    return [min(1.0, 0.22 + 0.48 * float(rgb[0])),
            min(1.0, 0.78 + 0.22 * float(rgb[1])),
            min(1.0, 0.02 + 0.18 * float(rgb[2]))]


def trace(image):
    hsv = cv2.cvtColor(image[:, :, :3], cv2.COLOR_RGB2HSV)
    alpha = image[:, :, 3]
    # This range isolates the neon front from the lower-value halo and black metal.
    face = ((hsv[:, :, 0] >= 30) & (hsv[:, :, 0] <= 95) &
            (hsv[:, :, 1] >= 120) & (hsv[:, :, 2] >= 185) & (alpha >= 250)).astype(np.uint8) * 255
    face = cv2.morphologyEx(face, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    face = cv2.morphologyEx(face, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    face = cv2.GaussianBlur(face, (0, 0), 1.5)
    _, face = cv2.threshold(face, 127, 255, cv2.THRESH_BINARY)
    # A bright source-side highlight arcs above M. It is not part of the face.
    yy, xx = np.indices(face.shape)
    face[(xx >= 160) & (xx <= 305) & (yy < 125 - .18 * (xx - 200))] = 0
    count, labels, stats, _ = cv2.connectedComponentsWithStats(face, 8)
    keep = [i for i in range(1, count) if stats[i, cv2.CC_STAT_AREA] >= 1000]
    face = np.isin(labels, keep).astype(np.uint8) * 255
    contours, hierarchy = cv2.findContours(face, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    hierarchy = hierarchy[0]
    groups = []
    for i, contour in enumerate(contours):
        if hierarchy[i, 3] != -1 or cv2.contourArea(contour) < 700:
            continue
        rings = []
        counters = [j for j in range(len(contours)) if hierarchy[j, 3] == i and
                    any(cv2.pointPolygonTest(contours[j], seed, False) >= 0 for seed in COUNTER_SEEDS)]
        candidates = [i] + counters
        for j, candidate in enumerate(candidates):
            c = cv2.approxPolyDP(contours[candidate], 1.85, True).reshape(-1, 2).astype(np.float64)
            if len(c) < 3:
                continue
            c[:, 1] *= -1  # image Y-down -> model Y-up
            if (signed_area(c) > 0) != (j == 0):
                c = c[::-1]
            rings.append(c)
        if rings:
            groups.append(rings)
    if len(groups) < 8:
        raise ValueError(f"Expected separate letter groups, found {len(groups)}")
    if sum(len(rings) - 1 for rings in groups) != len(COUNTER_SEEDS):
        raise ValueError('Expected all five source letter counters')
    ys, xs = np.nonzero(face)
    bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
    return face, groups, bbox


def normal_out(ring, i):
    p = ring[i]
    prev = p - ring[(i - 1) % len(ring)]
    following = ring[(i + 1) % len(ring)] - p
    for v in (prev, following):
        n = np.linalg.norm(v)
        if n:
            v /= n
    a = np.array([prev[1], -prev[0]])
    b = np.array([following[1], -following[0]])
    n = a + b
    length = np.linalg.norm(n)
    return n / length if length else b


class Mesh:
    def __init__(self):
        self.positions = []
        self.normals = []
        self.colors = []
        self.indices = []

    def vertex(self, position, normal, color):
        i = len(self.positions)
        self.positions.append([float(x) for x in position])
        self.normals.append([float(x) for x in normal])
        self.colors.append([float(x) for x in color])
        return i

    def triangle(self, a, b, c):
        self.indices.extend((int(a), int(b), int(c)))


def build_mesh(image, face, groups, bbox):
    x0, y0, x1, y1 = bbox
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    scale = 2 / (x1 - x0)
    front_z, rim_z, back_z = 0.09, 0.058, -0.09
    bevel_px = 2.5
    weight = (face > 0).astype(np.float32)
    numerator = cv2.GaussianBlur(image[:, :, :3].astype(np.float32) * weight[:, :, None], (0, 0), 12)
    denominator = cv2.GaussianBlur(weight, (0, 0), 12)
    color_field = numerator / np.maximum(denominator[:, :, None], .001) / 255
    front, shell = Mesh(), Mesh()
    world = lambda p: [(p[0] - cx) * scale, (p[1] + cy) * scale]
    faces = counters = 0

    for rings in groups:
        flat = np.concatenate(rings, axis=0).astype(np.float64)
        ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
        tri = mapbox_earcut.triangulate_float64(flat, ends)
        if not len(tri):
            raise ValueError("Earcut failed to triangulate a letter")
        expected = abs(signed_area(rings[0])) - sum(abs(signed_area(r)) for r in rings[1:])
        actual = 0.0
        for a, b, c in np.asarray(tri).reshape(-1, 3):
            actual += abs(signed_area(flat[[a, b, c]]))
        if abs(actual - expected) > max(25, expected * 0.03):
            raise ValueError(f"Letter triangulation mismatch: {actual:.1f} vs {expected:.1f}")
        faces += 1
        counters += len(rings) - 1

        # Shared front vertices make cap and bevel topologically watertight.
        front_vertices = {}
        def fv(p):
            key = (round(float(p[0]), 4), round(float(p[1]), 4))
            if key not in front_vertices:
                xy = world(p)
                front_vertices[key] = front.vertex([*xy, front_z], [0, 0, 1], rgb_at(color_field, p[0], -p[1]))
            return front_vertices[key]

        def cap_triangle(a, b, c):
            cross = signed_area(np.array([a, b, c]))
            front.triangle(fv(a), fv(b), fv(c)) if cross > 0 else front.triangle(fv(c), fv(b), fv(a))

        for a, b, c in np.asarray(tri).reshape(-1, 3):
            cap_triangle(flat[a], flat[b], flat[c])

        # Rear cap uses the expanded rim contour so its edges meet the side wall.
        expanded = np.concatenate([np.array([p + normal_out(ring, i) * bevel_px for i, p in enumerate(ring)]) for ring in rings])
        rear = [shell.vertex([*world(p), back_z], [0, 0, -1], [0.018, 0.045, 0.013]) for p in expanded]
        for a, b, c in np.asarray(tri).reshape(-1, 3):
            if signed_area(flat[[a, b, c]]) > 0:
                shell.triangle(rear[c], rear[b], rear[a])
            else:
                shell.triangle(rear[a], rear[b], rear[c])

        # Front outline -> narrow bevel -> substantial side wall. Each ring is
        # oriented so its right-hand normal points out of the solid, including holes.
        for ring in rings:
            edge_front, edge_rim, edge_back = [], [], []
            for i, p in enumerate(ring):
                out = normal_out(ring.copy(), i)
                xy = world(p)
                rim = world(p + out * bevel_px)
                face_rgb = rgb_at(color_field, p[0], -p[1])
                edge_front.append(shell.vertex([*xy, front_z], [out[0] * .45, out[1] * .45, .89], face_rgb))
                edge_rim.append(shell.vertex([*rim, rim_z], [out[0] * .92, out[1] * .92, .39], [0.15, 0.48, 0.055]))
                edge_back.append(shell.vertex([*rim, back_z], [out[0], out[1], 0], [0.026, 0.085, 0.018]))
            for i in range(len(ring)):
                j = (i + 1) % len(ring)
                shell.triangle(edge_front[i], edge_rim[i], edge_front[j])
                shell.triangle(edge_front[j], edge_rim[i], edge_rim[j])
                shell.triangle(edge_rim[i], edge_back[i], edge_rim[j])
                shell.triangle(edge_rim[j], edge_back[i], edge_back[j])

    points = np.asarray(front.positions + shell.positions)
    return front, shell, {'letterGroups': faces, 'counters': counters, 'pixelBounds': bbox,
                          'worldBounds': {'min': points.min(axis=0).tolist(), 'max': points.max(axis=0).tolist()},
                          'bevelPixels': bevel_px}


def topology_check(front, shell):
    edges = defaultdict(list)
    triangles = 0
    for mesh in (front, shell):
        positions = np.asarray(mesh.positions)
        for ix in np.asarray(mesh.indices).reshape(-1, 3):
            p = positions[ix]
            if np.linalg.norm(np.cross(p[1] - p[0], p[2] - p[0])) < 1e-10:
                raise ValueError('Degenerate logo triangle')
            vertices = [tuple(np.round(row, 7)) for row in p]
            for a, b in ((0, 1), (1, 2), (2, 0)):
                pair = tuple(sorted((vertices[a], vertices[b])))
                edges[pair].append((vertices[a], vertices[b]))
            triangles += 1
    open_edges = sum(len(v) != 2 for v in edges.values())
    winding_errors = sum(len(v) == 2 and v[0] != v[1][::-1] for v in edges.values())
    if open_edges or winding_errors:
        raise ValueError(f'Logo is not a closed oriented manifold: open/nonmanifold edges={open_edges}, winding errors={winding_errors}')
    return {'watertight': True, 'consistentWinding': True, 'geometricEdges': len(edges), 'triangles': triangles}


def write_glb(output, front, shell):
    binary = bytearray()
    views, accessors = [], []
    def accessor(array, component_type, type_name, target=None):
        raw = np.ascontiguousarray(array).tobytes()
        while len(binary) % 4:
            binary.append(0)
        offset = len(binary)
        binary.extend(raw)
        view = {'buffer': 0, 'byteOffset': offset, 'byteLength': len(raw)}
        if target is not None:
            view['target'] = target
        vi = len(views)
        views.append(view)
        a = {'bufferView': vi, 'componentType': component_type, 'count': len(array), 'type': type_name}
        if type_name == 'VEC3' and component_type == 5126:
            a['min'] = np.min(array, axis=0).astype(float).tolist()
            a['max'] = np.max(array, axis=0).astype(float).tolist()
        ai = len(accessors)
        accessors.append(a)
        return ai
    primitives = []
    for material, mesh in enumerate((front, shell)):
        p = np.asarray(mesh.positions, np.float32)
        n = np.asarray(mesh.normals, np.float32)
        c = np.asarray(mesh.colors, np.float32)
        ix = np.asarray(mesh.indices, np.uint32 if len(p) > 65535 else np.uint16)
        if not np.isfinite(p).all() or not np.isfinite(n).all() or not np.isfinite(c).all():
            raise ValueError('Nonfinite mesh attribute')
        primitives.append({'attributes': {'POSITION': accessor(p, 5126, 'VEC3', 34962),
                                          'NORMAL': accessor(n, 5126, 'VEC3', 34962),
                                          'COLOR_0': accessor(c, 5126, 'VEC3', 34962)},
                           'indices': accessor(ix, 5125 if ix.dtype == np.uint32 else 5123, 'SCALAR', 34963),
                           'material': material, 'mode': 4})
    gltf = {'asset': {'version': '2.0', 'generator': 'MPO source-contour logo extrusion'},
            'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': [{'mesh': 0, 'name': 'MONEY PRINTER OS extruded lettering'}],
            'meshes': [{'primitives': primitives}],
            'materials': [
                {'name': 'source-neon-front', 'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 0.08, 'roughnessFactor': 0.38}, 'emissiveFactor': [0.03, 0.13, 0.005]},
                {'name': 'dark-green-metal-bevel-and-sides', 'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 0.48, 'roughnessFactor': 0.28}, 'emissiveFactor': [0.005, 0.022, 0.002]},
            ], 'buffers': [{'byteLength': len(binary)}], 'bufferViews': views, 'accessors': accessors}
    json_bytes = json.dumps(gltf, separators=(',', ':')).encode('utf8')
    json_bytes += b' ' * (-len(json_bytes) % 4)
    binary.extend(b'\0' * (-len(binary) % 4))
    total = 12 + 8 + len(json_bytes) + 8 + len(binary)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('wb') as f:
        f.write(struct.pack('<4sII', b'glTF', 2, total))
        f.write(struct.pack('<I4s', len(json_bytes), b'JSON'))
        f.write(json_bytes)
        f.write(struct.pack('<I4s', len(binary), b'BIN\0'))
        f.write(binary)
    return {'bytes': total, 'frontVertices': len(front.positions), 'frontTriangles': len(front.indices) // 3,
            'shellVertices': len(shell.positions), 'shellTriangles': len(shell.indices) // 3,
            'primitives': len(primitives), 'accessorComponentTypes': [a['componentType'] for a in accessors]}


def preview(front, shell, output, degrees):
    """Build-only software projection for checking counters and visible side depth."""
    size = (1200, 760)
    canvas = np.full((size[1], size[0], 3), (5, 13, 3), np.uint8)
    a = math.radians(degrees)
    turn = np.array([[math.cos(a), 0, math.sin(a)], [0, 1, 0], [-math.sin(a), 0, math.cos(a)]])
    light = np.array([0.38, 0.48, 0.79])
    light /= np.linalg.norm(light)
    triangles = []
    for mesh in (shell, front):
        positions = np.asarray(mesh.positions) @ turn.T
        normals = np.asarray(mesh.normals) @ turn.T
        colors = np.asarray(mesh.colors)
        for ix in np.asarray(mesh.indices).reshape(-1, 3):
            pts = positions[ix]
            n = np.mean(normals[ix], axis=0)
            lit = .52 + .48 * max(0, float(np.dot(n, light)))
            color = np.clip(np.mean(colors[ix], axis=0) * lit * 255, 0, 255).astype(np.uint8)
            xy = np.rint(np.column_stack((600 + pts[:, 0] * 500, 370 - pts[:, 1] * 500))).astype(np.int32)
            triangles.append((float(np.mean(pts[:, 2])), xy, color[::-1].tolist()))
    for _, xy, color in sorted(triangles, key=lambda t: t[0]):
        cv2.fillConvexPoly(canvas, xy, color, lineType=cv2.LINE_AA)
    cv2.imwrite(str(output), canvas)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--source', type=Path, default=DEFAULT_SOURCE)
    ap.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    ap.add_argument('--manifest', type=Path, default=DEFAULT_MANIFEST)
    ap.add_argument('--preview-prefix', type=Path, help='Write build-only front/30/60 degree PNG previews')
    args = ap.parse_args()
    image = np.array(Image.open(args.source).convert('RGBA'))
    face, groups, bbox = trace(image)
    front, shell, geometry = build_mesh(image, face, groups, bbox)
    geometry['topology'] = topology_check(front, shell)
    exported = write_glb(args.output, front, shell)
    if args.preview_prefix:
        args.preview_prefix.parent.mkdir(parents=True, exist_ok=True)
        for angle in (0, 30, 60):
            preview(front, shell, args.preview_prefix.with_name(f'{args.preview_prefix.name}-{angle}.png'), angle)
    manifest = {'schema': 'mpo.logo-model.v1', 'source': args.source.name,
                'sourceSha256': hashlib.sha256(args.source.read_bytes()).hexdigest(),
                'model': args.output.name, 'modelSha256': hashlib.sha256(args.output.read_bytes()).hexdigest(),
                'sourcePixels': list(Image.open(args.source).size), 'geometry': geometry, 'glb': exported,
                'buildDependencies': {name: importlib.metadata.version(name) for name in
                                      ('Pillow', 'numpy', 'opencv-python-headless', 'mapbox-earcut')}}
    args.manifest.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf8')
    print(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    main()
