from __future__ import annotations

from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, select_autoescape
from weasyprint import CSS, HTML


def _jinja_env(templates_dir: Path) -> Environment:
    return Environment(
        loader=FileSystemLoader(str(templates_dir)),
        autoescape=select_autoescape(["html", "xml"]),
    )


def render_pdf(
    *,
    templates_dir: Path,
    template_name: str,
    context: dict[str, Any],
    output_path: Path,
    css_paths: list[Path] | None = None,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    env = _jinja_env(templates_dir)
    html_text = env.get_template(template_name).render(**context)

    css = [CSS(filename=str(p)) for p in (css_paths or [])]
    HTML(string=html_text, base_url=str(templates_dir)).write_pdf(target=str(output_path), stylesheets=css)

