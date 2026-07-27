async function main() {
  const handle = "0x0000aa36a72301b22db6962ee4168c2fad549575ac696528d7e732361b03bca4";
  const url = `https://gateway-testnets.noxprotocol.dev/v0/public/${handle}`;
  
  console.log(`Querying Nox Gateway: ${url}`);
  try {
    const res = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json"
      }
    });
    console.log("Status:", res.status);
    const data = await res.json();
    console.log("Data:", JSON.stringify(data, null, 2));
  } catch (err: any) {
    console.log("Fetch Error:", err.message);
  }
}

main();
