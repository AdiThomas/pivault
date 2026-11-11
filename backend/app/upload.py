"""Streaming upload reader.

Reads a request body straight to a temp file while computing its SHA-256, without
holding the file in memory or writing it twice. Accepts either multipart/form-data
(one file part plus small text fields) or a raw body (the file itself).
"""

import asyncio
import hashlib
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from python_multipart.multipart import MultipartParser, parse_options_header
from starlette.requests import ClientDisconnect, Request

MAX_FIELD_BYTES = 64 * 1024
MAX_FIELDS = 32


class UploadError(Exception):
    """The request body is not a usable upload."""


class UploadTooLarge(UploadError):
    pass


@dataclass
class StreamedUpload:
    tmp_path: Path
    size: int = 0
    sha256: str = ""
    filename: str | None = None
    content_type: str | None = None
    fields: dict[str, str] = field(default_factory=dict)


class _FileSink:
    """Buffers chunks from the parser callbacks; flushed to disk off the event loop."""

    def __init__(self, path: Path, max_bytes: int):
        self.path = path
        self.max_bytes = max_bytes
        self.size = 0
        self._hash = hashlib.sha256()
        self._pending: list[bytes] = []
        self._fh = open(path, "wb")  # noqa: ASYNC230 - writes happen in a worker thread

    def add(self, chunk: bytes) -> None:
        self.size += len(chunk)
        if self.size > self.max_bytes:
            raise UploadTooLarge(f"upload is larger than {self.max_bytes} bytes")
        self._pending.append(chunk)

    def _flush_sync(self) -> None:
        chunks, self._pending = self._pending, []
        for chunk in chunks:
            self._fh.write(chunk)
            self._hash.update(chunk)

    async def flush(self) -> None:
        if self._pending:
            await asyncio.to_thread(self._flush_sync)

    def close(self) -> None:
        if not self._fh.closed:
            self._fh.close()

    def hexdigest(self) -> str:
        return self._hash.hexdigest()


class _MultipartState:
    def __init__(self, sink: _FileSink, upload: StreamedUpload):
        self.sink = sink
        self.upload = upload
        self._header_field = b""
        self._header_value = b""
        self._headers: dict[str, str] = {}
        self._part_name: str | None = None
        self._is_file = False
        self._have_file = False
        self._field_buf = bytearray()

    # -- parser callbacks -------------------------------------------------
    def on_part_begin(self) -> None:
        self._headers = {}
        self._part_name = None
        self._is_file = False
        self._field_buf = bytearray()

    def on_header_field(self, data: bytes, start: int, end: int) -> None:
        self._header_field += data[start:end]

    def on_header_value(self, data: bytes, start: int, end: int) -> None:
        self._header_value += data[start:end]

    def on_header_end(self) -> None:
        name = self._header_field.decode("latin-1").lower()
        self._headers[name] = self._header_value.decode("utf-8", "replace")
        self._header_field = b""
        self._header_value = b""

    def on_headers_finished(self) -> None:
        disposition, params = parse_options_header(self._headers.get("content-disposition", ""))
        if disposition != b"form-data":
            raise UploadError("multipart part is missing a form-data disposition")
        self._part_name = params.get(b"name", b"").decode("utf-8", "replace")
        if b"filename" in params:
            if self._have_file:
                raise UploadError("only one file per request is supported")
            self._is_file = True
            self._have_file = True
            self.upload.filename = params[b"filename"].decode("utf-8", "replace")
            self.upload.content_type = self._headers.get("content-type")
        elif len(self.upload.fields) >= MAX_FIELDS:
            raise UploadError("too many form fields")

    def on_part_data(self, data: bytes, start: int, end: int) -> None:
        if self._is_file:
            self.sink.add(data[start:end])
        else:
            self._field_buf += data[start:end]
            if len(self._field_buf) > MAX_FIELD_BYTES:
                raise UploadError("form field is too large")

    def on_part_end(self) -> None:
        if not self._is_file and self._part_name:
            self.upload.fields[self._part_name] = self._field_buf.decode("utf-8", "replace")

    def callbacks(self) -> dict:
        return {
            "on_part_begin": self.on_part_begin,
            "on_header_field": self.on_header_field,
            "on_header_value": self.on_header_value,
            "on_header_end": self.on_header_end,
            "on_headers_finished": self.on_headers_finished,
            "on_part_data": self.on_part_data,
            "on_part_end": self.on_part_end,
        }

    @property
    def have_file(self) -> bool:
        return self._have_file


async def receive_upload(request: Request, tmp_dir: Path, max_bytes: int) -> StreamedUpload:
    """Stream the request body to a temp file. The caller owns (and must remove) it."""
    declared = request.headers.get("content-length")
    # Multipart framing adds a little overhead, so allow some slack on the header check.
    if declared and declared.isdigit() and int(declared) > max_bytes + 1024 * 1024:
        raise UploadTooLarge(f"upload is larger than {max_bytes} bytes")

    tmp_path = tmp_dir / f"{uuid.uuid4().hex}.part"
    upload = StreamedUpload(tmp_path=tmp_path)
    sink = _FileSink(tmp_path, max_bytes)
    content_type, params = parse_options_header(request.headers.get("content-type", ""))

    try:
        if content_type == b"multipart/form-data":
            boundary = params.get(b"boundary")
            if not boundary:
                raise UploadError("multipart request has no boundary")
            state = _MultipartState(sink, upload)
            parser = MultipartParser(boundary, state.callbacks())
            async for chunk in request.stream():
                if chunk:
                    parser.write(chunk)
                    await sink.flush()
            parser.finalize()
            await sink.flush()
            if not state.have_file:
                raise UploadError("no file part in the upload")
        else:
            if content_type == b"application/x-www-form-urlencoded":
                raise UploadError("no file part in the upload")
            upload.content_type = content_type.decode("latin-1") if content_type else None
            async for chunk in request.stream():
                if chunk:
                    sink.add(chunk)
                    await sink.flush()
            if sink.size == 0:
                raise UploadError("empty upload")
    except ClientDisconnect as exc:
        sink.close()
        tmp_path.unlink(missing_ok=True)
        raise UploadError("client disconnected during upload") from exc
    except UploadError:
        sink.close()
        tmp_path.unlink(missing_ok=True)
        raise
    except Exception as exc:  # malformed multipart from the parser
        sink.close()
        tmp_path.unlink(missing_ok=True)
        raise UploadError(f"malformed upload: {exc}") from exc

    sink.close()
    upload.size = sink.size
    upload.sha256 = sink.hexdigest()
    return upload
