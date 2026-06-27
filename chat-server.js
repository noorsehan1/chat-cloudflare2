// PERBAIKAN: Filter ketat - HANYA kirim data user lain
if (allSeats && Object.keys(allSeats).length > 0) {
  const filtered = {};
  for (const [seat, data] of Object.entries(allSeats)) {
    // Skip seat sendiri
    if (excludeSelf && selfSeat && parseInt(seat) === parseInt(selfSeat)) {
      continue;
    }
    // Skip data sendiri
    if (data && data.namauser === ws.username) {
      continue;
    }
    // Hanya kirim data user lain yang valid
    if (data && data.namauser) {
      filtered[seat] = { ...data };
    }
  }
  
  if (Object.keys(filtered).length > 0) {
    this.safeSend(ws, ["allUpdateKursiList", room, filtered]);
  }
}
