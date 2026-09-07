FROM python:3.13-slim
RUN useradd --create-home --uid 1000 app
WORKDIR /app
COPY --chown=app:app dashboard.py .
USER app
ENV REPORT_ROOT=/reports
EXPOSE 7860
CMD ["python", "-B", "dashboard.py"]
