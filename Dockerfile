FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PORT=8080
EXPOSE 8080
# 4 gevent workers: handles many concurrent Gemini calls without blocking
# --keep-alive 75: reuse HTTP connections (matches Cloud Run's 75s idle timeout)
# --graceful-timeout 30: clean shutdown during scaling events
CMD ["gunicorn", \
     "--bind", "0.0.0.0:8080", \
     "--workers", "4", \
     "--worker-class", "gevent", \
     "--worker-connections", "100", \
     "--timeout", "120", \
     "--keep-alive", "75", \
     "--graceful-timeout", "30", \
     "--log-level", "info", \
     "main:app"]
