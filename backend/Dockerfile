FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# WeasyPrint runtime deps (Debian slim)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libpangoft2-1.0-0 \
    libharfbuzz0b \
    libharfbuzz-subset0 \
    libgdk-pixbuf-2.0-0 \
    libffi8 \
    libjpeg62-turbo \
    libopenjp2-7 \
    libxml2 \
    libxslt1.1 \
    fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
COPY requirements-dev.txt /app/requirements-dev.txt
RUN pip install --no-cache-dir -r /app/requirements.txt -r /app/requirements-dev.txt

COPY app /app/app
COPY tests /app/tests
COPY scripts /app/scripts
COPY alembic.ini /app/alembic.ini
COPY alembic /app/alembic

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host=0.0.0.0", "--port=8000"]
