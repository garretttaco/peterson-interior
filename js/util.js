/* ============ Shared namespace + small utilities ============ */
window.PET = window.PET || {};
(function (PET) {
  "use strict";

  PET.mm = function (v) { return Math.round(v) + " mm"; };
  PET.m2 = function (mm2) { return (mm2 / 1e6).toFixed(2) + " m²"; };
  PET.clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  PET.uid = function () { return Math.random().toString(36).slice(2, 9); };

  PET.dist = function (x1, y1, x2, y2) { var dx = x2 - x1, dy = y2 - y1; return Math.sqrt(dx * dx + dy * dy); };

  /* distance from point to axis-aligned segment */
  PET.distToSeg = function (px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var l2 = dx * dx + dy * dy;
    if (l2 === 0) return PET.dist(px, py, x1, y1);
    var t = PET.clamp(((px - x1) * dx + (py - y1) * dy) / l2, 0, 1);
    return PET.dist(px, py, x1 + t * dx, y1 + t * dy);
  };

  /* do two axis-aligned rects overlap */
  PET.rectsOverlap = function (a, b) {
    return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
  };

  /* rotated footprint of a furniture item -> axis-aligned bounds */
  PET.furnBounds = function (f) {
    var r = (f.rot || 0) * Math.PI / 180;
    var c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
    var w = f.w * c + f.h * s, h = f.w * s + f.h * c;
    return { x1: f.x - w / 2, y1: f.y - h / 2, x2: f.x + w / 2, y2: f.y + h / 2 };
  };

  /* rotate a point around a centre */
  PET.rotatePt = function (px, py, cx, cy, deg) {
    var r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    var dx = px - cx, dy = py - cy;
    return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
  };

  /* point in rotated rect (item-local test) */
  PET.hitRotRect = function (px, py, cx, cy, w, h, rot) {
    var p = PET.rotatePt(px, py, cx, cy, -rot);
    return Math.abs(p.x - cx) <= w / 2 && Math.abs(p.y - cy) <= h / 2;
  };

  PET.niceNum = function (v) {
    return v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  };

  /* simple debounce */
  PET.debounce = function (fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  };

  /* rough stroke text helper for canvas */
  PET.text = function (ctx, str, x, y, opts) {
    opts = opts || {};
    ctx.save();
    ctx.font = opts.font || "11px Inter, sans-serif";
    ctx.fillStyle = opts.color || "#333";
    ctx.textAlign = opts.align || "center";
    ctx.textBaseline = opts.baseline || "middle";
    if (opts.bg) {
      var m = ctx.measureText(str);
      var pad = 3;
      var w = m.width + pad * 2, h = (opts.size || 11) + pad * 2;
      var bx = opts.align === "left" ? x - pad : opts.align === "right" ? x - w + pad : x - w / 2;
      var by = y - h / 2;
      ctx.fillStyle = opts.bg;
      ctx.beginPath();
      ctx.roundRect(bx, by, w, h, 3);
      ctx.fill();
      ctx.fillStyle = opts.color || "#333";
    }
    ctx.fillText(str, x, y);
    ctx.restore();
  };

  /* svg glyph per furniture type for the palette */
  PET.glyph = function (t) {
    var s = '<svg class="glyph" viewBox="0 0 26 20">';
    var f = '#8fa3b8', st = '#5c6b7a';
    switch (t) {
      case 'bed-king': case 'bed-queen':
        s += '<rect x="3" y="2" width="20" height="16" rx="2" fill="' + f + '" stroke="' + st + '"/><rect x="5" y="4" width="16" height="4" rx="1" fill="#e8ded0"/><line x1="13" y1="8" x2="13" y2="18" stroke="' + st + '"/>'; break;
      case 'sofa3': case 'armchair': case 'lounge':
        s += '<rect x="3" y="4" width="20" height="12" rx="3" fill="' + f + '" stroke="' + st + '"/><rect x="3" y="4" width="4" height="12" rx="2" fill="#7d95a8"/><rect x="19" y="4" width="4" height="12" rx="2" fill="#7d95a8"/>'; break;
      case 'diningtable': case 'coffee': case 'bistrotbl': case 'desk':
        s += '<rect x="4" y="4" width="18" height="12" rx="2" fill="#c9a97d" stroke="#8a7a63"/>'; break;
      case 'chair': case 'deskchair':
        s += '<rect x="9" y="5" width="8" height="10" rx="2" fill="#b9a888" stroke="#83755c"/>'; break;
      case 'island': case 'counter': case 'sinkbase': case 'sink': case 'vanity':
        s += '<rect x="2" y="6" width="22" height="8" rx="2" fill="#d8cdb8" stroke="#9a8d76"/><circle cx="13" cy="10" r="2.5" fill="#c2cbcf" stroke="#8b959c"/>'; break;
      case 'fridge': case 'washer': case 'dryer':
        s += '<rect x="5" y="2" width="16" height="16" rx="3" fill="#c6ced3" stroke="#8b959c"/>'; break;
      case 'toilet':
        s += '<rect x="10" y="2" width="6" height="5" fill="#e4e8ea" stroke="#9aa4ab"/><ellipse cx="13" cy="13" rx="5" ry="5" fill="#e4e8ea" stroke="#9aa4ab"/>'; break;
      case 'tub':
        s += '<rect x="2" y="5" width="22" height="10" rx="5" fill="#dde4e7" stroke="#9aa4ab"/>'; break;
      case 'shower':
        s += '<rect x="3" y="2" width="20" height="16" rx="2" fill="#bcd8e2" stroke="#7fa3b0"/>'; break;
      case 'rug':
        s += '<rect x="2" y="5" width="22" height="10" rx="1" fill="#d9c9a8" stroke="#bfa87f"/>'; break;
      case 'shelf': case 'bookshelf': case 'dresser': case 'dresser-t': case 'nightstand': case 'console': case 'tvconsole': case 'workbench':
        s += '<rect x="4" y="4" width="18" height="12" rx="2" fill="#b5a488" stroke="#7c6f58"/><line x1="4" y1="10" x2="22" y2="10" stroke="#7c6f58"/>'; break;
      case 'plant': case 'planter':
        s += '<circle cx="13" cy="10" r="7" fill="#8fae7e" stroke="#5f7a52"/>'; break;
      case 'car':
        s += '<rect x="6" y="1" width="14" height="18" rx="4" fill="#8fa6bd" stroke="#5d7d99"/><rect x="8" y="5" width="10" height="6" rx="2" fill="#c3d2e0"/>'; break;
      case 'bbq':
        s += '<rect x="5" y="6" width="16" height="10" rx="4" fill="#54585c"/><line x1="5" y1="8" x2="21" y2="8" stroke="#8d949b"/>'; break;
      case 'bench':
        s += '<rect x="3" y="7" width="20" height="6" rx="2" fill="#8fa3b8" stroke="#7b8794"/>'; break;
      default:
        s += '<rect x="5" y="5" width="16" height="10" rx="2" fill="' + f + '" stroke="' + st + '"/>';
    }
    return s + '</svg>';
  };

})(window.PET);
