const SOTUVCHI_BASE = "https://apiv3.sotuvchi.com/api";
const {token} = await (await fetch(`${SOTUVCHI_BASE}/login`,{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({email:"samanhusanov11@gmail.com",password:process.env.SOTUVCHI_PASSWORD})})).json();

// Default (no limit param)
const d1 = await (await fetch(`${SOTUVCHI_BASE}/getOrders`,{headers:{Authorization:`Bearer ${token}`,Accept:"application/json"}})).json();
console.log("Default (no limit):", d1.orders.per_page, "per page | last_page:", d1.orders.last_page);

// limit=100
const d2 = await (await fetch(`${SOTUVCHI_BASE}/getOrders?limit=100`,{headers:{Authorization:`Bearer ${token}`,Accept:"application/json"}})).json();
console.log("limit=100:         ", d2.orders.per_page, "per page | last_page:", d2.orders.last_page);

// limit=200
const d3 = await (await fetch(`${SOTUVCHI_BASE}/getOrders?limit=200`,{headers:{Authorization:`Bearer ${token}`,Accept:"application/json"}})).json();
console.log("limit=200:         ", d3.orders.per_page, "per page | last_page:", d3.orders.last_page);
