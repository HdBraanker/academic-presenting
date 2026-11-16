"""Regenerate figures/study-design.png (synthetic schematic). Run from examples/research-talk/: python3 figures/make_study_design.py"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

fig, ax = plt.subplots(figsize=(10, 4.2), dpi=200)
ax.set_xlim(0, 10); ax.set_ylim(0, 4.2); ax.axis("off")
ink, accent, muted = "#1B1F23", "#1F3A5F", "#646E78"
arrow = dict(arrowstyle="-|>", color=ink, lw=1.6, shrinkA=0, shrinkB=0)

def box(x, y, w, h, text, color, fill="white", size=12, bold=False):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.02,rounding_size=0.08", fc=fill, ec=color, lw=1.8))
    ax.text(x + w / 2, y + h / 2, text, ha="center", va="center", fontsize=size, color=ink, fontweight="bold" if bold else "normal")

box(0.1, 1.5, 2.6, 1.2, "240 biologic-naive\nadults with\nactive PsA", ink, bold=True)
ax.plot([2.72, 3.25], [2.1, 2.1], color=ink, lw=1.6)
ax.text(2.98, 2.25, "1:1", ha="center", fontsize=11, color=muted)
ax.plot([3.25, 3.25], [1.07, 3.12], color=ink, lw=1.6)
ax.annotate("", xy=(3.55, 3.12), xytext=(3.25, 3.12), arrowprops=arrow)
ax.annotate("", xy=(3.55, 1.07), xytext=(3.25, 1.07), arrowprops=arrow)
box(3.6, 2.65, 2.9, 0.95, "Examplimab (n = 120)", accent, fill="#F3F4F6", bold=True)
box(3.6, 0.6, 2.9, 0.95, "Placebo (n = 120)", muted)
ax.text(5.05, 2.1, "24 weeks, double-blind", ha="center", va="center", fontsize=11, color=muted)
ax.plot([6.55, 6.85], [3.12, 3.12], color=ink, lw=1.6)
ax.plot([6.55, 6.85], [1.07, 1.07], color=ink, lw=1.6)
ax.plot([6.85, 6.85], [1.07, 3.12], color=ink, lw=1.6)
ax.annotate("", xy=(7.25, 2.1), xytext=(6.85, 2.1), arrowprops=arrow)
box(7.3, 1.5, 2.6, 1.2, "Primary endpoint\nACR20\nat week 24", ink, bold=True)
ax.text(5.0, 0.12, "SYNTHETIC EXAMPLE - invented trial", ha="center", fontsize=9, color=muted, style="italic")
fig.savefig("figures/study-design.png", bbox_inches="tight", facecolor="white")
