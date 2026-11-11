# Воркер для фейсвапа: официальный worker-comfyui + нода ReActor и её зависимости.
# Модели лежат на сетевом диске (/runpod-volume/models), в образ не входят.
FROM runpod/worker-comfyui:5.10.0-base

# ReActor: onnxruntime-gpu для свопа на видеокарте, остальное — его собственные требования.
# insightface не нужен: с версии 0.7 ReActor считает эмбеддинги сам.
# Версия ORT — под Python 3.12 и CUDA 12.8 базового образа (1.20.1 колеса под 3.12 не имеет).
RUN /opt/venv/bin/pip install --no-cache-dir \
      onnxruntime-gpu==1.23.0 \
      "onnx>=1.14.0" "opencv-python-headless>=4.7.0.72" numpy \
      segment_anything "albumentations>=1.4.16" ultralytics colour-science scipy

# Нода ставится и в образ, и на диск при старте (см. start-faceswap.sh): если на диске
# окажется своя копия, она перекроет эту.
RUN git clone --depth 1 https://github.com/Gourieff/ComfyUI-ReActor /comfyui/custom_nodes/ComfyUI-ReActor \
    && /opt/venv/bin/pip install --no-cache-dir -r /comfyui/custom_nodes/ComfyUI-ReActor/requirements.txt

# Проверка сборки: ORT должен видеть CUDA-провайдер, torch не должен быть сломан.
RUN /opt/venv/bin/python -c "import onnxruntime as o, torch; \
      assert 'CUDAExecutionProvider' in o.get_available_providers(), o.get_available_providers(); \
      print('ORT', o.__version__, 'torch', torch.__version__)"

COPY start-faceswap.sh /start-faceswap.sh
RUN chmod +x /start-faceswap.sh

CMD ["/start-faceswap.sh"]
