import asyncio
import os
from dotenv import load_dotenv
from telethon import TelegramClient

load_dotenv()

API_ID = int(os.getenv("TG_API_ID", "0"))
API_HASH = os.getenv("TG_API_HASH")
PHONE = os.getenv("TG_PHONE")
TARGET_BOT = os.getenv("TARGET_BOT")

async def discover_markets():
    """Discover what markets are available in the bot's keyboard"""
    
    async with TelegramClient("user_session", API_ID, API_HASH) as client:
        if not await client.is_user_authorized():
            await client.send_code_request(PHONE)
            code = input("Enter the login code: ")
            await client.sign_in(PHONE, code)

        # Send /start to get the main menu
        print("Sending /start to get bot menu...")
        await client.send_message(TARGET_BOT, "/start")
        await asyncio.sleep(2.0)
        
        # Get the latest menu message
        menu = (await client.get_messages(TARGET_BOT, limit=1))[0]
        
        try:
            print(f"Menu message: {menu.message[:200]}...")
        except UnicodeEncodeError:
            print("Menu message: [Contains Unicode characters, displaying limited preview]")
        
        # Check if menu has inline keyboard
        if hasattr(menu, 'reply_markup') and menu.reply_markup:
            if hasattr(menu.reply_markup, 'rows'):
                print(f"\nFound {len(menu.reply_markup.rows)} rows in keyboard:")
                
                all_buttons = []
                for row_idx, row in enumerate(menu.reply_markup.rows):
                    print(f"Row {row_idx + 1}:")
                    for button_idx, button in enumerate(row.buttons):
                        button_text = button.text
                        try:
                            print(f"  Button {button_idx + 1}: '{button_text}'")
                        except UnicodeEncodeError:
                            print(f"  Button {button_idx + 1}: [Unicode text]")
                        all_buttons.append(button_text)
                
                print(f"\nAll available markets:")
                markets = [btn for btn in all_buttons if any(symbol in btn for symbol in ['USDT', 'USD']) and 'Binance' in btn]
                for i, market in enumerate(markets, 1):
                    try:
                        print(f"{i}. {market}")
                    except UnicodeEncodeError:
                        print(f"{i}. [Market with Unicode characters]")
                    
                print(f"\nTotal markets found: {len(markets)}")
                
                if len(markets) > 4:
                    try:
                        print(f"\n[SUCCESS] NEW MARKETS DETECTED! Previously had 4, now have {len(markets)}")
                    except UnicodeEncodeError:
                        print(f"\n[SUCCESS] NEW MARKETS DETECTED! Previously had 4, now have {len(markets)}")
                    new_markets = markets[4:]  # Assuming first 4 are the existing ones
                    print("New markets:")
                    for market in new_markets:
                        try:
                            print(f"  - {market}")
                        except UnicodeEncodeError:
                            print(f"  - [Market with Unicode characters]")
                
                # Generate Python list for easy copy-paste
                print(f"\nPython MARKETS list:")
                print("MARKETS = [")
                for market in markets:
                    try:
                        print(f'    "{market}",')
                    except UnicodeEncodeError:
                        print(f'    "[Market with Unicode]",')
                print("]")
                
                # Also write to file for easy copy
                with open("discovered_markets.txt", "w", encoding="utf-8") as f:
                    f.write("MARKETS = [\n")
                    for market in markets:
                        f.write(f'    "{market}",\n')
                    f.write("]\n")
                print("\nMarkets also saved to discovered_markets.txt")
                
            else:
                print("No keyboard rows found")
        else:
            print("No inline keyboard found in menu message")

if __name__ == "__main__":
    asyncio.run(discover_markets())