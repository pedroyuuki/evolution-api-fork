#!/usr/bin/env python3
"""Teste ponta a ponta dos endpoints principais da Evolution, contra instâncias reais.

Usa duas instâncias Baileys conectadas (A e B) que trocam mensagens entre si, e
opcionalmente o Chatwoot ligado à instância B. Valida o comportamento, não só o
HTTP: a mensagem chega na outra instância, o remoteJid sai pelo número, o webhook
dispara, a mídia é baixável, o Chatwoot recebe e envia.

Só usa a biblioteca padrão do Python. Rode antes de publicar uma imagem:

    SMOKE_API_KEY=... SMOKE_NUMBER_A=55... SMOKE_NUMBER_B=55... python3 test/e2e/smoke.py

Variáveis (padrões entre parênteses, os do QA local):
    SMOKE_API_URL          (http://localhost:8080)
    SMOKE_API_KEY          chave global da Evolution (obrigatória)
    SMOKE_INSTANCE_A/B     (qa-teste / qa-baileys)
    SMOKE_NUMBER_A/B       números das instâncias, só dígitos (obrigatórios)
    SMOKE_GROUP_JID        grupo onde B participa; sem ele os testes de grupo são pulados
    SMOKE_WEBHOOK_PORT     porta local do receptor de webhook (9914)
    SMOKE_WEBHOOK_URL      como a Evolution alcança esse receptor
                           (http://host.docker.internal:<porta>/hook). Use "off" quando a
                           Evolution não alcança esta máquina (servidor remoto): os testes
                           que dependem só do webhook são pulados e os demais seguem pela API.
    SMOKE_IMAGE_FILE       imagem PNG de teste (a favicon do manager)
    SMOKE_AUDIO_FILE       áudio de teste; sem ele é gerado um WAV de 2s
    SMOKE_CHATWOOT_URL     ex.: http://localhost:3000; sem URL e token o bloco é pulado
    SMOKE_CHATWOOT_TOKEN   token de acesso de um agente
    SMOKE_CHATWOOT_ACCOUNT (1)
    SMOKE_CHATWOOT_INBOX   id da caixa da instância B (1)

O anexo enviado pelo atendente só passa se a Evolution alcançar o FRONTEND_URL do
Chatwoot por um domínio com TLD (o envio de mídia por URL exige isso): no QA local,
use FRONTEND_URL=http://chatwoot.qa.local:3000 durante o teste.

A configuração de webhook da instância B é trocada durante o teste e restaurada no fim.
Sai com código 0 só se todos os testes executados passarem.
"""
import base64
import http.server
import io
import json
import math
import os
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def env(name, default=None, required=False):
    value = os.environ.get(name, default)
    if required and not value:
        sys.exit(f"Defina {name}")
    return value


API = env("SMOKE_API_URL", "http://localhost:8080").rstrip("/")
KEY = env("SMOKE_API_KEY", required=True)
A, B = env("SMOKE_INSTANCE_A", "qa-teste"), env("SMOKE_INSTANCE_B", "qa-baileys")
PN_A, PN_B = env("SMOKE_NUMBER_A", required=True), env("SMOKE_NUMBER_B", required=True)
JID_A, JID_B = PN_A + "@s.whatsapp.net", PN_B + "@s.whatsapp.net"
GROUP = env("SMOKE_GROUP_JID")
PORT = int(env("SMOKE_WEBHOOK_PORT", "9914"))
WEBHOOK_URL = env("SMOKE_WEBHOOK_URL", f"http://host.docker.internal:{PORT}/hook")
WEBHOOK_ON = WEBHOOK_URL.lower() != "off"
CW_URL = (env("SMOKE_CHATWOOT_URL") or "").rstrip("/")
CW_TOKEN = env("SMOKE_CHATWOOT_TOKEN")
CW_ACCOUNT = env("SMOKE_CHATWOOT_ACCOUNT", "1")
CW_INBOX = int(env("SMOKE_CHATWOOT_INBOX", "1"))
CW = f"{CW_URL}/api/v1/accounts/{CW_ACCOUNT}" if CW_URL and CW_TOKEN else None
TAG = time.strftime("%H%M%S")
IMAGE_FILE = env("SMOKE_IMAGE_FILE", os.path.join(ROOT, "manager/dist/assets/images/favicon.png"))


def tone_wav(seconds=2, rate=8000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / rate))) for i in range(rate * seconds)))
    return buf.getvalue()


IMG = base64.b64encode(open(IMAGE_FILE, "rb").read()).decode()
AUDIO_FILE = env("SMOKE_AUDIO_FILE")
AUD = base64.b64encode(open(AUDIO_FILE, "rb").read() if AUDIO_FILE else tone_wav()).decode()
PDF = base64.b64encode(
    b"%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj "
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"
).decode()

# ------------------------------------------------------------------ receptor de webhook
EVENTS = []
EVENTS_LOCK = threading.Lock()


def strip_base64(value):
    if isinstance(value, dict):
        return {k: (len(v) if k == "base64" and isinstance(v, str) else strip_base64(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [strip_base64(v) for v in value]
    return value


class WebhookHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        try:
            body = json.loads(raw)
            row = {"event": body.get("event"), "data": strip_base64(body.get("data"))}
        except Exception as error:
            row = {"event": None, "data": {"parse_error": str(error)}}
        with EVENTS_LOCK:
            EVENTS.append(row)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args):
        pass


def events(event=None, contains=None):
    with EVENTS_LOCK:
        rows = list(EVENTS)
    return [
        r for r in rows
        if (not event or r["event"] == event) and (not contains or contains in json.dumps(r["data"], ensure_ascii=False))
    ]


# ------------------------------------------------------------------ helpers
def request(method, url, body=None, headers=None, timeout=90):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **(headers or {})}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read()
            return response.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            return error.code, json.loads(raw)
        except Exception:
            return error.code, raw.decode()[:300]


def api(method, path, body=None):
    return request(method, API + path, body, {"apikey": KEY})


def cw(method, path, body=None):
    return request(method, CW + path, body, {"api_access_token": CW_TOKEN})


def wait(predicate, timeout=40, interval=1.5):
    end = time.time() + timeout
    while time.time() < end:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return None


def find_msg(instance, msg_id):
    status, body = api("POST", f"/chat/findMessages/{instance}", {"where": {"key": {"id": msg_id}}})
    records = (body or {}).get("messages", {}).get("records", []) if status == 200 else []
    return records[0] if records else None


def received(instance, msg_id, timeout=40):
    return wait(lambda: find_msg(instance, msg_id), timeout)


def send(path, body, instance=A):
    status, response = api("POST", f"/message/{path}/{instance}", body)
    assert status in (200, 201), f"HTTP {status}: {str(response)[:200]}"
    return response["key"]["id"]


def check_received(msg_id, expected_type, instance=B, sender_jid=JID_A):
    record = received(instance, msg_id)
    if not record:
        return False, f"{msg_id} não chegou em {instance}"
    jid = record["key"]["remoteJid"]
    if record["messageType"] != expected_type:
        return False, f"tipo {record['messageType']} != {expected_type}"
    if jid != sender_jid:
        return False, f"remoteJid {jid} != {sender_jid}"
    return True, f"chegou como {record['messageType']}, remoteJid={jid}"


results = []
ctx = {}


class Skip(Exception):
    pass


def test(block, name):
    def decorator(fn):
        started = time.time()
        try:
            ok, detail = fn()
            status = "OK  " if ok else "FAIL"
        except Skip as reason:
            ok, detail, status = None, str(reason), "SKIP"
        except Exception as error:  # o próximo teste roda mesmo assim
            ok, detail, status = False, f"{type(error).__name__}: {error}", "FAIL"
            traceback.print_exc()
        results.append({"block": block, "name": name, "ok": ok, "detail": detail, "seconds": round(time.time() - started, 1)})
        print(f"{status} [{block}] {name} — {detail}", flush=True)
        return fn
    return decorator


def need_webhook():
    if not WEBHOOK_ON:
        raise Skip("SMOKE_WEBHOOK_URL=off")


def run():
    # ---------------------------------------------------------------- infraestrutura
    @test("infra", "GET / (versão)")
    def _():
        status, body = api("GET", "/")
        return status == 200 and body.get("version"), f"HTTP {status} versão {body.get('version')}"

    @test("infra", "fetchInstances: as duas instâncias abertas")
    def _():
        status, body = api("GET", "/instance/fetchInstances")
        states = {i["name"]: i["connectionStatus"] for i in body if i["name"] in (A, B)}
        return states == {A: "open", B: "open"}, str(states)

    @test("infra", "connectionState")
    def _():
        states = [api("GET", f"/instance/connectionState/{i}")[1]["instance"]["state"] for i in (A, B)]
        return states == ["open", "open"], str(states)

    @test("infra", "settings/find")
    def _():
        status, _body = api("GET", f"/settings/find/{B}")
        return status == 200, f"HTTP {status}"

    @test("infra", "webhook/set liga o webhook e o base64 sem reiniciar a instância")
    def _():
        need_webhook()
        status, body = api("POST", f"/webhook/set/{B}", {"webhook": {
            "enabled": True, "url": WEBHOOK_URL, "byEvents": False, "base64": True,
            "events": ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "MESSAGES_DELETE", "SEND_MESSAGE", "MESSAGES_EDITED"]}})
        return status in (200, 201) and body.get("enabled") and body.get("webhookBase64"), f"HTTP {status}"

    # ---------------------------------------------------------------- contatos
    @test("contatos", "whatsappNumbers resolve o número para o JID canônico")
    def _():
        status, body = api("POST", f"/chat/whatsappNumbers/{A}", {"numbers": [PN_B]})
        r = body[0]
        return r.get("exists") and r.get("jid") == JID_B, f"exists={r.get('exists')} jid={r.get('jid')}"

    @test("contatos", "fetchProfilePictureUrl")
    def _():
        status, body = api("POST", f"/chat/fetchProfilePictureUrl/{A}", {"number": PN_B})
        return status == 200 and "profilePictureUrl" in body, f"HTTP {status}"

    @test("contatos", "sendPresence (digitando)")
    def _():
        status, _body = api("POST", f"/chat/sendPresence/{A}", {"number": PN_B, "presence": "composing", "delay": 1000})
        return status in (200, 201), f"HTTP {status}"

    # ---------------------------------------------------------------- mensagens A -> B
    @test("mensagens", "sendText chega no destino com remoteJid pelo número")
    def _():
        ctx["text"] = send("sendText", {"number": PN_B, "text": f"[smoke {TAG}] texto"})
        return check_received(ctx["text"], "conversation")

    @test("mensagens", "webhook MESSAGES_UPSERT do destino com o mesmo remoteJid")
    def _():
        need_webhook()
        found = wait(lambda: events("messages.upsert", ctx["text"]), 20)
        if not found:
            return False, "evento não chegou"
        key = found[0]["data"]["key"]
        return key["remoteJid"] == JID_A, f"remoteJid={key['remoteJid']} remoteJidAlt={key.get('remoteJidAlt')}"

    @test("mensagens", "resposta citando preserva a referência")
    def _():
        mid = send("sendText", {"number": PN_B, "text": f"[smoke {TAG}] resposta citando",
                                "quoted": {"key": {"id": ctx["text"]}, "message": {"conversation": "texto"}}})
        record = received(B, mid)
        stanza = ((record or {}).get("contextInfo") or {}).get("stanzaId")
        return stanza == ctx["text"], f"stanzaId={stanza}"

    @test("mensagens", "imagem: base64 no webhook e getBase64 só com a chave")
    def _():
        mid = send("sendMedia", {"number": PN_B, "mediatype": "image", "mimetype": "image/png",
                                 "caption": f"[smoke {TAG}] imagem", "media": IMG, "fileName": "smoke.png"})
        ok, detail = check_received(mid, "imageMessage")
        if not ok:
            return ok, detail
        found = wait(lambda: events("messages.upsert", mid), 20) if WEBHOOK_ON else None
        webhook_b64 = found[0]["data"]["message"].get("base64", 0) if found else 0
        status, body = api("POST", f"/chat/getBase64FromMediaMessage/{B}", {"message": {"key": {"id": mid}}})
        return (webhook_b64 > 0 or not WEBHOOK_ON) and status in (200, 201) and len(body.get("base64", "")) > 0, \
            f"webhook base64={webhook_b64} endpoint HTTP {status} base64={len(body.get('base64', ''))}"

    @test("mensagens", "documento preserva o nome do arquivo")
    def _():
        mid = send("sendMedia", {"number": PN_B, "mediatype": "document", "mimetype": "application/pdf",
                                 "caption": f"[smoke {TAG}] doc", "media": PDF, "fileName": "smoke.pdf"})
        record = received(B, mid)
        if not record:
            return False, "não chegou"
        content = record["message"]
        doc = content.get("documentMessage") or content.get("documentWithCaptionMessage", {}).get("message", {}).get("documentMessage") or {}
        status, _body = api("POST", f"/chat/getBase64FromMediaMessage/{B}", {"message": {"key": {"id": mid}}})
        return doc.get("fileName") == "smoke.pdf" and status in (200, 201), f"fileName={doc.get('fileName')} getBase64 HTTP {status}"

    @test("mensagens", "áudio chega como nota de voz e converte para mp4")
    def _():
        mid = send("sendWhatsAppAudio", {"number": PN_B, "audio": AUD})
        record = received(B, mid)
        if not record:
            return False, "não chegou"
        ptt = record["message"].get("audioMessage", {}).get("ptt")
        status, body = api("POST", f"/chat/getBase64FromMediaMessage/{B}", {"message": {"key": {"id": mid}}, "convertToMp4": True})
        return record["messageType"] == "audioMessage" and ptt and body.get("mimetype") == "audio/mp4", \
            f"ptt={ptt} convertToMp4 mimetype={body.get('mimetype')}"

    @test("mensagens", "sendLocation")
    def _():
        return check_received(send("sendLocation", {"number": PN_B, "name": "Smoke", "address": "Teste",
                                                    "latitude": -23.42, "longitude": -51.93}), "locationMessage")

    @test("mensagens", "sendContact")
    def _():
        return check_received(send("sendContact", {"number": PN_B, "contact": [
            {"fullName": "Smoke Contato", "wuid": PN_A, "phoneNumber": "+" + PN_A}]}), "contactMessage")

    @test("mensagens", "sendPoll")
    def _():
        record = received(B, send("sendPoll", {"number": PN_B, "name": f"[smoke {TAG}] enquete", "selectableCount": 1, "values": ["A", "B"]}))
        return bool(record) and record["messageType"].startswith("pollCreationMessage"), f"tipo={(record or {}).get('messageType')}"

    @test("mensagens", "sendReaction a uma mensagem recebida")
    def _():
        status, response = api("POST", f"/message/sendReaction/{B}", {"key": {"remoteJid": JID_A, "fromMe": False, "id": ctx["text"]}, "reaction": "👍"})
        assert status in (200, 201), f"HTTP {status} {response}"
        record = received(A, response["key"]["id"])
        return bool(record) and record["messageType"] == "reactionMessage", f"tipo={(record or {}).get('messageType')}"

    @test("mensagens", "sentido inverso: B -> A")
    def _():
        return check_received(send("sendText", {"number": PN_A, "text": f"[smoke {TAG}] inverso"}, instance=B),
                              "conversation", instance=A, sender_jid=JID_B)

    # ---------------------------------------------------------------- edição, exclusão, leitura
    @test("ciclo", "updateMessage chega ao destino e marca a cópia de quem editou")
    def _():
        mid = send("sendText", {"number": PN_B, "text": f"[smoke {TAG}] antes da edição"})
        received(B, mid)
        status, _r = api("POST", f"/chat/updateMessage/{A}", {"number": PN_B, "key": {"id": mid, "remoteJid": JID_B, "fromMe": True},
                                                           "text": f"[smoke {TAG}] editada"})
        edited = wait(lambda: [e for e in events(contains=mid) if e["event"] in ("messages.update", "messages.edited", "messages.upsert")
                               and "editada" in json.dumps(e["data"], ensure_ascii=False)], 25) if WEBHOOK_ON else [{"event": "(webhook off)"}]
        record = find_msg(A, mid) or {}
        statuses = [u.get("status") for u in record.get("MessageUpdate") or []]
        return status in (200, 201) and bool(edited) and "EDITED" in statuses, \
            f"HTTP {status}; evento no destino={edited[0]['event'] if edited else 'nenhum'}; status no remetente={statuses}"

    @test("ciclo", "editar mensagem alheia é recusado antes de sair para o WhatsApp")
    def _():
        mid = send("sendText", {"number": PN_B, "text": f"[smoke {TAG}] não pode ser editada pelo outro"})
        received(B, mid)
        before = len(events())
        status, response = api("POST", f"/chat/updateMessage/{B}", {"number": PN_A, "key": {"id": mid, "remoteJid": JID_A, "fromMe": False}, "text": "invasao"})
        if not WEBHOOK_ON:
            return status == 400, f"HTTP {status} (sem webhook, o vazamento não é verificado)"
        time.sleep(6)
        # B emite SEND_MESSAGE para tudo o que envia: nenhum evento com o texto = nada saiu.
        leaked = [e for e in events()[before:] if "invasao" in json.dumps(e["data"])]
        return status == 400 and not leaked, f"HTTP {status}; edição vazou={'sim' if leaked else 'não'}"

    @test("ciclo", "deleteMessageForEveryone chega ao destino")
    def _():
        mid = send("sendText", {"number": PN_B, "text": f"[smoke {TAG}] vai ser apagada"})
        received(B, mid)
        status, _r = api("DELETE", f"/chat/deleteMessageForEveryone/{A}", {"id": mid, "remoteJid": JID_B, "fromMe": True})
        if not WEBHOOK_ON:
            return status in (200, 201), f"HTTP {status} (sem webhook, a chegada no destino não é verificada)"
        found = wait(lambda: [e for e in events(contains=mid) if e["event"] in ("messages.delete", "messages.update")
                              and (e["event"] == "messages.delete" or "REVOKE" in json.dumps(e["data"]) or "DELETED" in json.dumps(e["data"]))], 25)
        return status in (200, 201) and bool(found), f"HTTP {status}; evento no destino={found[0]['event'] if found else 'nenhum'}"

    @test("ciclo", "markMessageAsRead e status lido no remetente")
    def _():
        status, _r = api("POST", f"/chat/markMessageAsRead/{B}", {"readMessages": [{"remoteJid": JID_A, "fromMe": False, "id": ctx["text"]}]})

        def read_status():
            s, body = api("POST", f"/chat/findStatusMessage/{A}", {"where": {"id": ctx["text"]}})
            return [u for u in (body or []) if u.get("status") in ("READ", "PLAYED")] if s == 200 else None

        got = wait(read_status, 25)
        return status in (200, 201) and bool(got), f"HTTP {status}; status no remetente={got[0]['status'] if got else 'sem READ'}"

    # ---------------------------------------------------------------- consultas
    @test("consultas", "findChats tem a conversa pelo número")
    def _():
        status, body = api("POST", f"/chat/findChats/{B}", {})
        jids = [c["remoteJid"] for c in body]
        return JID_A in jids, f"{len(jids)} chats; @lid legados={len([j for j in jids if j.endswith('@lid')])}"

    @test("consultas", "findContacts e findChatByRemoteJid")
    def _():
        a = api("POST", f"/chat/findContacts/{B}", {"where": {"remoteJid": JID_A}})
        b = api("GET", f"/chat/findChatByRemoteJid/{B}?remoteJid={JID_A}")
        return a[0] == 200 and len(a[1]) >= 1 and b[0] == 200, f"contatos={len(a[1])} chat HTTP {b[0]}"

    @test("consultas", "getBase64 com corpo inválido devolve erro claro")
    def _():
        status, body = api("POST", f"/chat/getBase64FromMediaMessage/{B}", {"message": {}})
        text = json.dumps(body, ensure_ascii=False)
        return status == 400 and "TypeError" not in text, f"HTTP {status} {text[:100]}"

    # ---------------------------------------------------------------- grupos
    @test("grupos", "fetchAllGroups e findGroupInfos")
    def _():
        if not GROUP:
            raise Skip("SMOKE_GROUP_JID não definido")
        a = api("GET", f"/group/fetchAllGroups/{B}?getParticipants=false")
        b = api("GET", f"/group/findGroupInfos/{B}?groupJid={GROUP}")
        return a[0] == 200 and b[0] == 200 and b[1].get("id") == GROUP, f"{len(a[1])} grupos; {b[1].get('subject')}"

    @test("grupos", "sendText para grupo")
    def _():
        if not GROUP:
            raise Skip("SMOKE_GROUP_JID não definido")
        record = received(B, send("sendText", {"number": GROUP, "text": f"[smoke {TAG}] grupo"}, instance=B), 20)
        return bool(record) and record["key"]["remoteJid"] == GROUP, f"remoteJid={(record or {}).get('key', {}).get('remoteJid')}"

    # ---------------------------------------------------------------- Chatwoot
    def need_chatwoot():
        if not CW:
            raise Skip("SMOKE_CHATWOOT_URL/TOKEN não definidos")

    def conversation():
        _s, body = cw("POST", "/contacts/filter", {"payload": [{"attribute_key": "identifier", "filter_operator": "equal_to", "values": [JID_A], "query_operator": None}]})
        contact = body["payload"][0]
        _s, convs = cw("GET", f"/contacts/{contact['id']}/conversations")
        conv = sorted([c for c in convs["payload"] if c["inbox_id"] == CW_INBOX], key=lambda c: -c["last_activity_at"])[0]
        return contact, conv

    def messages_with(text, attachment=False):
        _s, body = cw("GET", f"/conversations/{ctx['conv']}/messages")
        return [m for m in body["payload"] if text in (m.get("content") or "") and (not attachment or m.get("attachments"))]

    def delivered_to_a(text, message_type=None):
        _s, body = api("POST", f"/chat/findMessages/{A}", {"where": {"key": {"remoteJid": JID_B}}, "offset": 15})
        return [r for r in body["messages"]["records"]
                if text in json.dumps(r["message"], ensure_ascii=False) and (not message_type or r["messageType"] == message_type)]

    @test("chatwoot", "mensagem recebida aparece no contato único pelo número")
    def _():
        need_chatwoot()
        contact, conv = conversation()
        ctx["conv"] = conv["id"]
        got = wait(lambda: messages_with(f"[smoke {TAG}] texto"), 20)
        return bool(got), f"contato #{contact['id']} identifier={contact['identifier']} phone={contact['phone_number']}"

    @test("chatwoot", "imagem recebida chega como anexo")
    def _():
        need_chatwoot()
        return bool(wait(lambda: messages_with(f"[smoke {TAG}] imagem", attachment=True), 25)), "anexo presente"

    @test("chatwoot", "resposta do atendente é entregue no WhatsApp")
    def _():
        need_chatwoot()
        status, _m = cw("POST", f"/conversations/{ctx['conv']}/messages", {"content": f"[smoke {TAG}] atendente", "message_type": "outgoing"})
        got = wait(lambda: delivered_to_a(f"[smoke {TAG}] atendente"), 30)
        return status == 200 and bool(got), f"Chatwoot HTTP {status}; entregue={'sim' if got else 'não'}"

    @test("chatwoot", "anexo enviado pelo atendente é entregue no WhatsApp")
    def _():
        need_chatwoot()
        out = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", "-H", f"api_access_token: {CW_TOKEN}",
                              "-F", f"content=[smoke {TAG}] anexo atendente", "-F", "message_type=outgoing",
                              "-F", f"attachments[]=@{IMAGE_FILE};type=image/png", f"{CW}/conversations/{ctx['conv']}/messages"],
                             capture_output=True, text=True).stdout
        got = wait(lambda: delivered_to_a(f"[smoke {TAG}] anexo", "imageMessage"), 40)
        return out == "200" and bool(got), f"Chatwoot HTTP {out}; entregue={'sim' if got else 'não (FRONTEND_URL com TLD?)'}"


def main():
    if not WEBHOOK_ON:
        run()
        return summarize()
    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), WebhookHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    _s, previous_webhook = api("GET", f"/webhook/find/{B}")
    try:
        run()
    finally:
        # Devolve a instância B à configuração de webhook que ela tinha.
        if previous_webhook:
            api("POST", f"/webhook/set/{B}", {"webhook": {
                "enabled": previous_webhook.get("enabled", False), "url": previous_webhook.get("url") or WEBHOOK_URL,
                "byEvents": previous_webhook.get("webhookByEvents", False), "base64": previous_webhook.get("webhookBase64", False),
                "events": previous_webhook.get("events") or ["MESSAGES_UPSERT"], "headers": previous_webhook.get("headers") or {}}})
        else:
            api("POST", f"/webhook/set/{B}", {"webhook": {"enabled": False, "url": WEBHOOK_URL, "byEvents": False, "base64": False, "events": ["MESSAGES_UPSERT"]}})
        server.shutdown()
    summarize()


def summarize():
    ran = [r for r in results if r["ok"] is not None]
    passed = sum(1 for r in ran if r["ok"])
    skipped = len(results) - len(ran)
    print(f"\n{passed}/{len(ran)} passaram" + (f", {skipped} pulados" if skipped else ""))
    report = os.path.join(tempfile.gettempdir(), f"evolution-smoke-{TAG}.json")
    json.dump(results, open(report, "w"), ensure_ascii=False, indent=1)
    print(f"relatório: {report}")
    sys.exit(0 if passed == len(ran) else 1)


if __name__ == "__main__":
    main()
