"""Check account discovery and watch live events from registered Keurig brewers."""

import argparse
import asyncio
import getpass
import logging
import sys
import time

import httpx
from pykeurig.const import API_URL, CLIENT_ID
from pykeurig.keurigapi import KeurigApi
from signalrcoreplus.hub_connection_builder import HubConnectionBuilder


async def check_sign_in(api, credentials=None):
    """Use the pinned client's login request but preserve actionable errors."""
    payload = {}
    if credentials is not None:
        email, password = credentials
        payload = dict(grant_type="password", client_id=CLIENT_ID, username=email, password=password)
    headers = api._get_headers({"Accept-Encoding": "identity"})
    try:
        async with httpx.AsyncClient(headers=headers, timeout=10) as client:
            response = await client.post(f"{API_URL}api/claa/v1/oauth/token", json=payload)
    except httpx.RequestError as exc:
        raise RuntimeError(f"Could not reach Keurig sign-in ({type(exc).__name__}).") from None

    status = response.status_code
    is_html = "text/html" in response.headers.get("content-type", "").lower()
    if response.headers.get("cf-mitigated") == "challenge" or (
        status == 403 and is_html and "cloudflare" in response.headers.get("server", "").lower()
    ):
        raise RuntimeError(f"Keurig's Cloudflare gateway blocked the legacy password endpoint (HTTP {status}). "
                           "See the browser sign-in findings in README.md. Retrying your password will not resolve this block.")
    try:
        data = response.json()
    except ValueError:
        data = None
    if credentials is None:
        if status in (400, 401, 422) and isinstance(data, dict):
            print(f"Keurig returned a JSON error for the empty request (HTTP {status}). "
                  "Account sign-in is still untested.")
            return
        raise RuntimeError(f"The empty request returned HTTP {status}. "
                           "The result is inconclusive for account sign-in.")
    if not response.is_success:
        error = data.get("error") if isinstance(data, dict) else None
        # Only emit recognized OAuth codes. Other fields can contain account data.
        known = ("invalid_grant", "invalid_client", "unsupported_grant_type", "invalid_request")
        detail = f", {error}" if error in known else ""
        raise RuntimeError(f"Keurig rejected the client's sign-in request (HTTP {status}{detail}).")
    try:
        access, refresh = data["access_token"], data["refresh_token"]
        expires_at = time.time() + int(data["expires_in"]) - 120
        if not all(isinstance(value, str) and value for value in (access, refresh)):
            raise ValueError
    except (KeyError, TypeError, ValueError, OverflowError):
        raise RuntimeError(f"Keurig returned HTTP {status} with an unexpected token response.") from None
    api._access_token, api._refresh_token, api._token_expires_at = access, refresh, expires_at


async def watch(api, devices):
    # Obtain the same short-lived hub credentials used by the pinned client.
    # Register our own handler so the client does not print raw device payloads.
    token = await api._async_get_signalr_access_token()
    hub = HubConnectionBuilder().with_url(
        api._signalr_url, options={"access_token_factory": lambda: token}
    ).build()
    loop = asyncio.get_running_loop()
    events = asyncio.Queue()
    names = {device.id: device.name for device in devices}

    def enqueue(kind, payload=None):
        loop.call_soon_threadsafe(events.put_nowait, (kind, payload))

    hub.on_open(lambda: enqueue("open"))
    hub.on_close(lambda: enqueue("closed"))
    hub.on_error(lambda *_: enqueue("error"))
    hub.on("appliance-notifications", lambda args: enqueue("event", args))
    deadline = loop.time() + 30
    try:
        hub.start()
        while True:
            remaining = deadline - loop.time() if deadline is not None else None
            kind, payload = await asyncio.wait_for(events.get(), remaining)
            if kind == "open":
                deadline = None
                print("Listening. Toggle brewer power in the Keurig app. Press Ctrl+C to finish.")
            elif kind == "event":
                for message in payload or []:
                    if not isinstance(message, dict) or message.get("deviceId") not in names:
                        continue
                    body = message.get("body")
                    state = body.get("current") if isinstance(body, dict) else None
                    detail = f" -> {state}" if isinstance(state, (str, int)) else ""
                    print(f"{names[message['deviceId']]} | {message.get('eventType', 'event')}{detail}")
            else:
                raise RuntimeError("The live event connection closed. Run the check again to reconnect.")
    except TimeoutError:
        raise RuntimeError("No live connection confirmation arrived within 30 seconds.") from None
    finally:
        hub.stop()


async def main(check_login=False):
    api = KeurigApi()
    if check_login:
        print("Checking the sign-in endpoint with an empty request. No account details are sent.")
        await check_sign_in(api)
        return
    if not sys.stdin.isatty():
        raise RuntimeError("Open an interactive terminal to enter your Keurig credentials.")
    email = input("Keurig account email: ").strip()
    password = getpass.getpass("Keurig password (hidden): ")
    if not email or not password:
        raise RuntimeError("Enter the email and password used by your Keurig app.")
    print("Signing in to Keurig...")
    await check_sign_in(api, (email, password))
    del password
    print("Looking for registered brewers...")
    devices = await api.async_get_devices()
    if not devices:
        raise RuntimeError("Sign-in succeeded, but this account returned no brewers.")
    for device in devices:
        print(f"Found {device.name} | model {device.model}")
    print("Connecting to live events...")
    await watch(api, devices)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-login", action="store_true", help="check the sign-in endpoint without credentials")
    args = parser.parse_args()
    # Transport error logs may contain authenticated URLs. Report the stage instead.
    logging.disable(logging.CRITICAL)
    try:
        asyncio.run(main(args.check_login))
    except KeyboardInterrupt:
        print("\nStopped.")
    except RuntimeError as exc:
        sys.exit(str(exc))
    except httpx.HTTPStatusError as exc:
        sys.exit(f"Keurig returned HTTP {exc.response.status_code} during the step shown above.")
    except Exception as exc:
        sys.exit(f"Check failed during the step shown above ({type(exc).__name__}).")
