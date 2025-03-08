import { chromium, Page, BrowserContext } from 'playwright';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

interface LinkedInCredentials {
    email: string;
    password: string;
}

class LinkedInBot {
    private page: Page | null = null;
    private context: BrowserContext | null = null;
    private readonly credentials: LinkedInCredentials;
    private readonly authFile = path.join(__dirname, 'linkedinAuth.json');
    
    constructor(credentials: LinkedInCredentials) {
        this.credentials = credentials;
    }

    async init() {
        const browser = await chromium.launch({ headless: false });
        
        // Try to load saved authentication state
        if (fs.existsSync(this.authFile)) {
            console.log('Loading saved authentication state...');
            this.context = await browser.newContext({
                storageState: this.authFile
            });
        } else {
            this.context = await browser.newContext();
        }
        
        this.page = await this.context.newPage();
    }

    async login() {
        if (!this.page || !this.context) throw new Error('Browser not initialized');

        // Check if we need to login
        await this.page.goto('https://www.linkedin.com/feed/');
        const isLoggedIn = await this.page.url().includes('/feed/');

        if (!isLoggedIn) {
            console.log('Logging in...');
            await this.page.goto('https://www.linkedin.com/login');
            await this.page.fill('#username', this.credentials.email);
            await this.page.fill('#password', this.credentials.password);
            await this.page.click('button[type="submit"]');
            
            // Wait for navigation
            await this.page.waitForNavigation();

            // Save authentication state
            await this.context.storageState({ path: this.authFile });
            console.log('Authentication state saved');
        } else {
            console.log('Already logged in');
        }
    }

    async connectWithGroupMembers() {
        if (!this.page) throw new Error('Browser not initialized');

        console.log('Navigating to group members page...');
        await this.page.goto(process.env.LINKEDIN_GROUP_URL!);
        await this.page.waitForTimeout(5000);

        // First collect all profile URLs from the group page
        const profileUrls: string[] = [];
        let previousHeight = 0;
        let noNewContentCount = 0;

        // Scroll and collect all URLs first
        console.log('Collecting profile URLs...');
        while (true) {
            try {
                // Get all member cards that are currently visible
                const memberCards = await this.page.$$('.artdeco-list__item');
                
                for (const card of memberCards) {
                    try {
                        // Get profile URL and degree
                        const profileUrl = await card.$eval('a[href*="/in/"]', (link: HTMLAnchorElement) => link.href)
                            .catch(() => null);
                        const degreeText = await card.$eval('.artdeco-entity-lockup__degree', el => el.textContent?.trim())
                            .catch(() => null);
                        
                        if (profileUrl && 
                            !profileUrls.includes(profileUrl) && 
                            (!degreeText || (!degreeText.includes('1st') && !degreeText.includes('You')))) {
                            profileUrls.push(profileUrl);
                            console.log(`Added profile: ${profileUrl}`);
                        }
                    } catch (error) {
                        continue; // Skip problematic cards
                    }
                }
                
                break

                // Scroll logic
                // console.log(`Collected ${profileUrls.length} profiles so far, scrolling for more...`);
                // const currentHeight = await this.page.evaluate(() => document.body.scrollHeight);
                // await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                // await this.randomDelay(2000, 4000);

                // if (currentHeight === previousHeight) {
                //     noNewContentCount++;
                //     if (noNewContentCount >= 3) {
                //         console.log('No new profiles found after 3 scroll attempts, finished collecting.');
                //         break;
                //     }
                // } else {
                //     noNewContentCount = 0;
                // }
                // previousHeight = currentHeight;

            } catch (error) {
                console.log('Error while collecting profiles:', error);
                break;
            }
        }

        console.log(`Total profiles collected: ${profileUrls.length}`);

        // Now process each collected profile
        const MAX_CONNECTIONS_PER_DAY = 25;
        let connectionsAttempted = 0;

        for (let i = 0; i < profileUrls.length; i++) {
            if (connectionsAttempted >= MAX_CONNECTIONS_PER_DAY) {
                console.log('Reached maximum connections for today');
                break;
            }

            const profileUrl = profileUrls[i];
            await this.randomDelay(2000, 4000);
            console.log(`Processing profile ${i + 1}/${profileUrls.length}: ${profileUrl}`);
            
            const connected = await this.tryConnectWithProfile(profileUrl)
                .catch(error => {
                    console.log(`Failed to connect with profile ${profileUrl}:`, error);
                    return false;
                });

            if (connected) {
                connectionsAttempted++;
                console.log(`Successfully connected! (${connectionsAttempted}/${MAX_CONNECTIONS_PER_DAY})`);
            } else {
                console.log(`Connection attempt failed. Moving to next profile.`);
            }
        }

        console.log(`Finished processing profiles. Connected with ${connectionsAttempted} people.`);
    }

    // New method to handle profile connection attempts
    private async tryConnectWithProfile(profileUrl: string): Promise<boolean> {
        if (!this.page) throw new Error('Browser not initialized');

        try {
            await this.page.goto(profileUrl);
            await this.page.waitForTimeout(2000);
            let connected = false;

            // Updated selector for the main connect button
            console.log('Looking for direct Connect button...');
            const connectButton = await this.page.$([
                // Primary selector using exact classes and aria-label pattern
                'button[id*="ember"].artdeco-button.artdeco-button--2.artdeco-button--primary[aria-label*="Invite"][aria-label*="to connect"]',
                
                // Backup selector with just the essential parts
                'button.artdeco-button--primary[aria-label*="Invite"][id*="ember"]'
            ].join(','));

            if (connectButton) {
                console.log('Found direct Connect button, attempting to click...');
                
                // Log button details for debugging
                const buttonText = await connectButton.textContent();
                const ariaLabel = await connectButton.getAttribute('aria-label');
                const buttonId = await connectButton.getAttribute('id');
                console.log(`Button found - Text: ${buttonText}, ID: ${buttonId}, Aria-label: ${ariaLabel}`);

                try {
                    await connectButton.click({ timeout: 60000, force: true });
                    console.log('Successfully clicked Connect button');
                    connected = await this.handleConnectionDialog();
                } catch (clickError) {
                    console.log('Failed to click button directly, trying JavaScript click...');
                    await this.page.evaluate((button) => {
                        (button as HTMLElement).click();
                    }, connectButton);
                    connected = await this.handleConnectionDialog();
                }
            } else {
                console.log('No direct connect button found, trying More dropdown...');
                const moreButton = await this.page.$([
                    'button.artdeco-dropdown__trigger[aria-label="More actions"]',
                    'button[id*="profile-overflow-action"]',
                    'button.artdeco-button--muted:has(span:text("More"))'
                ].join(','));
                
                if (moreButton) {
                    console.log('Found More button, clicking...');
                    await moreButton.click();
                    await this.page.waitForTimeout(2000);

                    const connectOption = await this.page.$(
                        'div.artdeco-dropdown__item[aria-label*="Invite"][aria-label*="connect"], ' + 
                        'div.artdeco-dropdown__item:has(span:text("Connect"))'
                    );
                    
                    if (connectOption) {
                        console.log('Found Connect option in dropdown, clicking...');
                        await connectOption.click({ timeout: 60000 });
                        connected = await this.handleConnectionDialog();
                    }
                }
            }

            return connected;

        } catch (error) {
            console.log(`Error while trying to connect with ${profileUrl}:`, error);
            return false;
        }
    }

    private async randomDelay(min: number, max: number) {
        const delay = Math.floor(Math.random() * (max - min + 1)) + min;
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    private async clickWithRetry(selector: string, maxAttempts: number = 3, timeout: number = 60000) {
        if (!this.page) throw new Error('Browser not initialized');
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                console.log(`Attempt ${attempt} to click ${selector}`);
                await this.page.waitForSelector(selector, { timeout, state: 'visible' });
                await this.page.click(selector, { timeout });
                return true;
            } catch (error) {
                console.log(`Click attempt ${attempt} failed:`, error);
                if (attempt === maxAttempts) throw error;
                await this.randomDelay(2000, 4000);
            }
        }
        return false;
    }

    private async handleConnectionDialog(): Promise<boolean> {
        try {
            await this.page?.waitForTimeout(2000);
            
            // Try multiple selectors for the "Send without note" button
            const sendButton = await this.page?.$([
                'button:has-text("Send without a note")',
                'button:has-text("Send")',
                'button[aria-label*="Send now"]',
                'button.artdeco-button--primary:has-text("Send")'
            ].join(','));

            if (sendButton) {
                console.log('Found Send button, clicking...');
                await sendButton.click({ timeout: 60000 });
                await this.page?.waitForTimeout(2000);
                return true;
            } else {
                console.log('No send button found in dialog');
                return false;
            }
        } catch (error) {
            console.log('Error handling connection dialog:', error);
            return false;
        }
    }

    async close() {
        if (this.context) {
            await this.context.close();
        }
    }
}

async function main() {
    const bot = new LinkedInBot({
        email: process.env.LINKEDIN_EMAIL!,
        password: process.env.LINKEDIN_PASSWORD!
    });

    try {
        await bot.init();
        await bot.login();
        await bot.connectWithGroupMembers();
    } catch (error) {
        console.error('Bot error:', error);
    } finally {
        await bot.close();
    }
}

main();
