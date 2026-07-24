"""
Instagram 3×4 Grid Maker — Backend API
======================================
Receives an image + editor state, splits into a 3-column × 4-row grid,
and returns a ZIP of 12 JPEG tiles numbered for correct Instagram upload order.

Stack: Flask + Pillow  (Vercel Serverless Function)
All processing happens in memory — no files written to disk.

Works in two modes:
  - Vercel: vercel.json handles static files + routes /api/* to Flask
  - Local:  Flask serves everything (static files + API at /api/*)
"""

import os
import io
import zipfile
from PIL import Image
from flask import (
    Flask, request, jsonify, Response, send_from_directory,
)

# ---------------------------------------------------------------------------
# Locate the public/ directory relative to this file
#   api/index.py  →  ../public/
# ---------------------------------------------------------------------------
_THIS_DIR = os.path.abspath(os.path.dirname(__file__))
_PUBLIC_DIR = os.path.join(_THIS_DIR, os.pardir, 'public')

# ---------------------------------------------------------------------------
# MIME type map for static files (Flask will auto-detect most, but explicit is safer)
# ---------------------------------------------------------------------------
_STATIC_EXTENSIONS = {
    '.html': 'text/html',
    '.css':  'text/css',
    '.js':   'application/javascript',
    '.json': 'application/json',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
}

app = Flask(__name__, static_folder=None)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
COLS = 3
ROWS = 4
TOTAL_TILES = COLS * ROWS  # 12
MAX_FILE_SIZE = 25 * 1024 * 1024  # 25 MB
ACCEPTED_MIME = {'image/jpeg', 'image/png', 'image/webp'}
JPEG_QUALITY = 92
ZIP_COMPRESSION = zipfile.ZIP_DEFLATED


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def validate_request():
    """Validate the incoming request. Returns (error_response, None) or (None, form_data)."""
    if 'image' not in request.files:
        return jsonify(error='No image file provided.'), 400

    file = request.files['image']

    # Check MIME type
    mime = file.content_type or ''
    if mime not in ACCEPTED_MIME:
        return jsonify(error=f'Unsupported file type: {mime}. Use JPG, PNG, or WEBP.'), 400

    # Read bytes and validate size early
    try:
        file_bytes = file.read()
    except Exception:
        return jsonify(error='Failed to read the uploaded file.'), 400

    if len(file_bytes) > MAX_FILE_SIZE:
        return jsonify(error=f'File too large ({len(file_bytes)} bytes). Maximum is {MAX_FILE_SIZE} bytes.'), 400

    if len(file_bytes) == 0:
        return jsonify(error='Uploaded file is empty.'), 400

    # Parse transform parameters
    try:
        offset_x = float(request.form.get('offsetX', 0))
        offset_y = float(request.form.get('offsetY', 0))
        scale    = float(request.form.get('scale', 1))
        canvas_w = float(request.form.get('canvasWidth', 0))
        canvas_h = float(request.form.get('canvasHeight', 0))
    except (ValueError, TypeError):
        return jsonify(error='Invalid transform parameters.'), 400

    if scale <= 0:
        return jsonify(error='Scale must be positive.'), 400
    if canvas_w <= 0 or canvas_h <= 0:
        return jsonify(error='Canvas dimensions must be positive.'), 400

    return None, {
        'file_bytes': file_bytes,
        'mime': mime,
        'offset_x': offset_x,
        'offset_y': offset_y,
        'scale': scale,
        'canvas_w': canvas_w,
        'canvas_h': canvas_h,
    }


def process_image(data):
    """
    Core image processing pipeline.

    1. Open image from bytes (Pillow / BytesIO)
    2. Create a virtual canvas matching the editor's grid dimensions
    3. Draw the image on the canvas with the editor's transform (scale + offset)
    4. Split the canvas into COLS × ROWS tiles
    5. Number tiles for correct Instagram upload order (top-left first)
    6. Return an in-memory ZIP of JPEG tiles
    """
    file_bytes = data['file_bytes']
    offset_x   = data['offset_x']
    offset_y   = data['offset_y']
    scale      = data['scale']
    canvas_w   = data['canvas_w']
    canvas_h   = data['canvas_h']

    # Step 1: Open image from memory
    try:
        img = Image.open(io.BytesIO(file_bytes))
    except Exception:
        raise ValueError('Cannot open image. The file may be corrupt or unsupported.')

    # Ensure image is in RGB mode (convert RGBA/P/LA)
    if img.mode != 'RGB':
        img = img.convert('RGB')

    # Step 2: Calculate the scaled image dimensions
    scaled_w = img.width * scale
    scaled_h = img.height * scale

    # Step 3: Create a canvas matching the editor's grid size
    # Use the canvas dimensions from the frontend (in CSS pixels)
    canvas = Image.new('RGB', (int(round(canvas_w)), int(round(canvas_h))), (0, 0, 0))

    # Paste the image onto the canvas with the editor's offset
    # We need to handle negative offsets (parts of image outside canvas)
    paste_x = int(round(offset_x))
    paste_y = int(round(offset_y))

    # Create the transformed image at the scaled size
    if scale != 1.0:
        resized = img.resize(
            (int(round(scaled_w)), int(round(scaled_h))),
            Image.Resampling.LANCZOS
        )
    else:
        resized = img

    # Calculate the visible portion that overlaps with the canvas
    src_x = max(0, -paste_x)
    src_y = max(0, -paste_y)
    dst_x = max(0, paste_x)
    dst_y = max(0, paste_y)

    # Crop the source image to the visible area
    crop_w = min(resized.width - src_x, canvas.width - dst_x)
    crop_h = min(resized.height - src_y, canvas.height - dst_y)

    if crop_w > 0 and crop_h > 0:
        cropped = resized.crop((src_x, src_y, src_x + crop_w, src_y + crop_h))
        canvas.paste(cropped, (dst_x, dst_y))

    # Step 4: Split into tiles
    tile_w = canvas.width / COLS
    tile_h = canvas.height / ROWS

    tiles = []
    for row in range(ROWS):
        for col in range(COLS):
            left   = int(round(col * tile_w))
            top    = int(round(row * tile_h))
            right  = int(round((col + 1) * tile_w))
            bottom = int(round((row + 1) * tile_h))
            tile = canvas.crop((left, top, right, bottom))
            tiles.append((row, col, tile))

    # Step 5: Generate ZIP in memory
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, 'w', compression=ZIP_COMPRESSION) as zf:
        # Number tiles for correct Instagram upload order:
        # When user uploads 01 first, it becomes the oldest post → top-left (0,0).
        # When user uploads 12 last, it becomes the newest post → bottom-right (3,2).
        # So tile at (0,0) = upload_01, tile at (3,2) = upload_12.
        # Number tiles in natural reading order (row by row, left to right).
        for idx, (row, col, tile) in enumerate(tiles):
            tile_buf = io.BytesIO()
            tile.save(tile_buf, format='JPEG', quality=JPEG_QUALITY)
            tile_buf.seek(0)
            tile_bytes = tile_buf.getvalue()

            name = f'upload_{idx + 1:02d}.jpg'
            zf.writestr(name, tile_bytes)

    zip_buffer.seek(0)
    return zip_buffer


# ---------------------------------------------------------------------------
# API Routes
# ---------------------------------------------------------------------------

def _process_image_handler():
    """Shared logic for the process-image endpoint (called by both route paths)."""
    validation_err, data = validate_request()
    if validation_err is not None:
        return validation_err

    try:
        zip_buffer = process_image(data)
    except ValueError as e:
        return jsonify(error=str(e)), 400
    except Exception as e:
        app.logger.error(f'Processing error: {e}', exc_info=True)
        return jsonify(error='An internal error occurred during image processing.'), 500

    return Response(
        zip_buffer.getvalue(),
        mimetype='application/zip',
        headers={
            'Content-Disposition': 'attachment; filename="instagram_grid.zip"',
            'Content-Length': str(len(zip_buffer.getvalue())),
        },
    )


# Vercel hits this path (vercel.json strips the /api/ prefix)
@app.route('/process-image', methods=['POST'])
def handle_process_image():
    """API endpoint for Vercel: /api/process-image → /process-image"""
    return _process_image_handler()


# Local gunicorn hits this path directly (no reverse proxy to strip prefix)
@app.route('/api/process-image', methods=['POST'])
def handle_process_image_api():
    """API endpoint for local dev: /api/process-image"""
    return _process_image_handler()


# Health check (both paths)
@app.route('/health', methods=['GET'])
def health_check():
    return jsonify(status='ok'), 200


@app.route('/api/health', methods=['GET'])
def health_check_api():
    return jsonify(status='ok'), 200


# ---------------------------------------------------------------------------
# Static File Serving — for local development
#   Vercel serves static files via vercel.json; these routes are only
#   needed when running with gunicorn / flask directly.
# ---------------------------------------------------------------------------

@app.route('/')
def serve_index():
    """Serve the main index.html at the root path."""
    return send_from_directory(_PUBLIC_DIR, 'index.html')


@app.route('/<path:filename>')
def serve_static(filename):
    """
    Serve any static file from the public/ directory.
    Falls through to index.html for unknown paths (SPA-style).
    """
    filepath = os.path.join(_PUBLIC_DIR, filename)

    # Security: prevent directory traversal
    if not os.path.abspath(filepath).startswith(os.path.abspath(_PUBLIC_DIR)):
        return jsonify(error='Not found'), 404

    if os.path.isfile(filepath):
        return send_from_directory(_PUBLIC_DIR, filename)

    # Unknown path → serve index.html (client-side routing fallback)
    return send_from_directory(_PUBLIC_DIR, 'index.html')
