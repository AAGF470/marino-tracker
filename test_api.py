import httpx

try:
    request = httpx.get('https://goboardapi.azurewebsites.net/api/FacilityCount/GetCountsByAccount?AccountAPIKey=2a2be0d8-df10-4a48-bedd-b3bc0cd628e7')
    print(request.status_code)
    print(request.text)
except httpx.RequestError as e:
    print(f"Request failed: {e}")
except httpx.HTTPStatusError as e:
    print(f"Bad status code: {e}")